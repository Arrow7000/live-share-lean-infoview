# Design & internals

Deep-dive notes for contributors. For install/usage, see the top-level
[`README`](../README.md).

## Architecture

```
GUEST extension host                         HOST extension host                Lean server
┌─────────────────────────┐                  ┌─────────────────────────┐        ┌──────────┐
│ @leanprover/infoview     │  postMessage RPC │ host bridge             │  LSP   │  lake    │
│ (real React app, webview)│ ◄──────────────► │  - relays $/lean/rpc/*  │ ─────► │  serve   │
│  + EditorApi shim        │                  │  - owns keepalive       │ ◄───── │          │
│  + cursor → position     │   BridgeChannel  │  - fans out notifs      │  stdio └──────────┘
│  + GuestEditorClient     │ ◄──────────────► │  - vsls:↔file: translate│
└─────────────────────────┘   (WebSocket      │  - reuses vscode-lean4's │
                               over Live Share │    LeanClient via exports│
                               shareServer)    └─────────────────────────┘
```

- **Host:** obtains vscode-lean4's `LeanClient` (via its public `exports`), runs a
  localhost WebSocket server, and exposes it to guests with Live Share's
  `shareServer(port)`. Each guest connection becomes a `LeanBridgeHost` that
  relays the infoview's Lean-specific RPC to the real server, owns RPC-session
  keepalive, fans out server notifications, and translates URIs.
- **Guest:** connects to that port, hosts the real `@leanprover/infoview` React
  app in a webview, and implements the infoview's `EditorApi` so its RPC goes
  over the bridge to the host instead of to a local server. Driven by the guest's
  cursor in the shared document.
- **Transport-agnostic seam:** everything is written against an abstract
  `BridgeChannel` (`src/bridge/types.ts`). Three implementations exist —
  `LoopbackChannel` (in-process, for tests), `WebSocketChannel` (sockets / the
  production path), and `LiveShareChannel` (a `shareService` adapter, see below).
  This is what lets ~everything be tested without Live Share.

## Why `shareServer`, not `shareService`

Live Share's generic messaging API (`shareService` / `getSharedService`) is the
obvious transport, and the `LiveShareChannel` adapter implements it. **But it is
gated by Live Share to an allowlist** — for a third-party extension it returns
`null`. The vsls API docs admit this ("Access to shared services may be
restricted. If the caller is not permitted, this method returns `null`"), and a
real two-window test confirmed it (`shareService returned null`). This is exactly
the blocker described in [vscode-lean4#390](https://github.com/leanprover/vscode-lean4/issues/390).

`shareServer(port)` carries **no** such restriction note, so the bridge tunnels a
localhost WebSocket port instead. The port is derived deterministically from
`session.id` (identical on host and guest), so the two peers agree on it without
needing the gated channel to exchange it. On one machine the guest reaches the
host's server directly; across machines Live Share tunnels the port.

Because the bridge is transport-agnostic, this pivot only swapped the adapter —
the host/guest logic and all tests were unchanged.

## Verified findings (Lean / vscode-lean4 / Live Share)

Verified against a read-only clone of `leanprover/vscode-lean4` (`@leanprover/infoview`
0.13.0) and a live `Lean 4 Server 0.3.0` (toolchain `v4.30.0`).

### Custom RPC wire methods

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `$/lean/rpc/connect` | request | `{ uri }` | `{ sessionId }` |
| `$/lean/rpc/call` | request | `{ sessionId, method, params, textDocument:{uri}, position }` | method-specific |
| `$/lean/rpc/keepAlive` | notification | `{ uri, sessionId }` | — |
| `$/lean/rpc/release` | notification | `{ uri, sessionId, refs }` | — |
| `$/lean/fileProgress` | server→client notif | `{ textDocument:{uri,version}, processing }` | — |
| `textDocument/publishDiagnostics` | server→client notif | standard + Lean `fullRange`/`isSilent`/`leanTags` | — |

Goal/widget methods are passed *inside* `$/lean/rpc/call` as the `method` field:
`Lean.Widget.getInteractiveGoals` (params `{ textDocument, position }`, result
`{ goals: InteractiveGoal[] }`), `getInteractiveTermGoal`,
`getInteractiveDiagnostics`, `getWidgets`, `getWidgetSource`, `getGoToLocation`,
`InteractiveDiagnostics.{msgToInteractive,infoToInteractive}`,
`lazyTraceChildrenToInteractive`, `highlightMatches`.

### Keepalive

`keepAlivePeriodMs = 10000` (10s). **The editor/extension owns keepalive, not the
infoview** (the webview can't reliably `setInterval` when hidden) — so on the
bridge the **host** owns keepalive per RPC session.

### RPC wire format

The server advertises `experimental.rpcProvider.rpcWireFormat = "v1"` (RPC refs
are `{ "__rpcref": "<string>" }`). The bridge forwards refs as **opaque JSON**, so
it needs no special handling, but it **must forward `$/lean/rpc/release`** so
server-side refs get GC'd.

### vscode-lean4 exports its `LeanClient` — no fork needed

`activate()` returns `Promise<Exports>`; `exports.lean4EnabledFeatures` resolves to
`{ clientProvider, infoProvider, ... }`. From a companion extension:

```ts
const ext = vscode.extensions.getExtension('leanprover.lean4')!
const { clientProvider } = await (await ext.activate()).lean4EnabledFeatures
const client = clientProvider.findClient(extUri) // LeanClient
```

`LeanClient` exposes `sendRequest`/`sendNotification` and events `diagnostics`
(raw `LeanPublishDiagnosticsParams`, incl. silent ones + `leanTags`),
`customNotification` (`$/lean/*`), `progressChanged`, `restarted`, `stopped`.
`LeanClientProvider` exposes `findClient`, `getClients`, `getClientForFolder`,
`ensureClient`, and a `clientAdded` event.

### `EditorApi` / `InfoviewApi`

Defined in `@leanprover/infoview-api`. The infoview talks to its editor only
through `EditorApi`; the infoview builds its RPC layer on top of it (RPC calls are
just `sendClientRequest(uri, '$/lean/rpc/call', params)`). **`EditorApi` is the
seam we re-implement for the guest.** The webview↔extension transport is a small
`seqNum`-based JSON-RPC, with `sendClientRequest` split into
`startClientRequest`/`awaitClientRequest`/`cancelClientRequest` for cancellation.

### Infoview loader

`@leanprover/infoview` (ESM) exposes `.` (the React app, `renderInfoview`, must
**not** be transpiled to UMD) and `./loader` (`loadRenderInfoview(imports, args,
next)`, which sets up an `importmap` via `es-module-shims`). We use the loader.

### "Goals accomplished" (the blue ✓) is a *silent* diagnostic

The checkmark is a diagnostic tagged `leanTags: [GoalsAccomplished]` with
`isSilent: true`. lean4 **filters silent diagnostics out of VS Code's diagnostic
collection** (so they don't appear in Problems), so `vscode.languages.getDiagnostics()`
never contains the tag. To replay it on join, the host reads lean4's own raw
accumulated store (`LeanClient.diagnosticCollection.diags`, a private field —
graceful fallback if it ever changes). The live path uses the `diagnostics` event,
which fires the full set including silent ones.

## Repository layout

```
src/lean-rpc/        headless LSP + custom-RPC client (reused by the host bridge)
  leanRpcTypes.ts      wire types + method-name constants + TaggedText flatten
  leanServerConnection.ts   speaks LSP/custom-RPC over a spawned `lean --server`
  fixtureServer.ts     launch + elaborate the fixture, resolve the goal position
  m1-spike.ts          standalone spike / CLI; captureGolden.ts records a payload
src/bridge/          the transport-agnostic bridge
  types.ts             BridgeChannel + LeanClientLike + the bridge protocol
  loopbackChannel.ts   in-process channel (JSON round-trips to mimic the wire)
  webSocketChannel.ts  localhost socket channel (the production transport)
  liveShareChannel.ts  shareService adapter (gated in practice; kept for reference)
  uriTranslation.ts    pure vsls:↔file: remapping + a translating host channel
  leanBridgeHost.ts    host side: relay rpc/*, own keepalive, fan out notifs
  guestEditorClient.ts guest side: EditorApi-shaped client over a channel
src/infoview/        webview glue (framework-agnostic, unit-testable)
  api.ts               EditorApi / InfoviewApi / EditorRpcApi types
  rpc.ts               webview↔host postMessage RPC + editorApiOfRpc
  guestEditorApi.ts    guest EditorRpcApi impl backed by GuestEditorClient
extension/           the companion VS Code extension
  esbuild.mjs          builds extension (node) + webview (browser) + copies assets
  webview/main.ts      re-hosts @leanprover/infoview via loader + importmap
  src/hostRole.ts      host wiring (lean4 exports → LeanBridgeHost over shareServer)
  src/guestRole.ts     guest wiring (infoview + cursor + gutter over the bridge)
  src/leanClientAdapter.ts   vscode-lean4 LeanClient → LeanClientLike
  src/infoviewWebview.ts     host-side webview manager (Rpc + InfoviewApi proxy)
  src/goalsAccomplishedGutter.ts   blue ✓ gutter decoration on the guest
  src/replayEditor.ts        serves the golden payload (for the render test)
fixtures/lean-fixture/   one-theorem Lean project with a deterministic goal
fixtures/golden/         captured interactive-goals payload for the render test
experiments/vsls-smoke/  throwaway probe confirming shareService is gated
reference/vscode-lean4/  upstream clone, read-only, git-ignored
```

## Testing strategy

Almost everything is verified without Live Share or a human:

- **Headless Lean RPC** (`test/lean-rpc.integration.test.ts`): spawn a real Lean
  server, drive the custom RPC, assert on the goal. The riskiest part, in isolation.
- **Bridge data plane** (`test/bridge.*.test.ts`, `guest-chain.test.ts`): the host
  bridge against a real Lean server over loopback and over real sockets, plus the
  full guest path (webview `EditorApi` → RPC → bridge → real Lean) minus the React
  render. Bridge unit logic runs over **both** transports with a stub client.
- **Webview render** (`extension/test`, `@vscode/test-electron`): launches real VS
  Code, renders a captured goal in the real infoview, asserts via the infoview's
  own `getInfoviewHtml()`.
- **`LiveShareChannel`** is tested against a faithful in-process vsls mock.

The only thing not machine-tested is Live Share's own session plumbing — covered
by the manual two-window test (`./scripts/dev-liveshare.sh`).

## Upstreaming into vscode-lean4

This is a working prototype of #390. Folding it into vscode-lean4 is arguably the
ideal end state, and the code is structured to make that port mechanical (the
seam is already the same `EditorApi` upstream uses). Note it **must** be installed
on both peers regardless (the guest needs *some* extension to host the webview and
speak the bridge — a host-only install can't work).

- `src/bridge/*` and `src/infoview/{rpc,api,guestEditorApi}.ts` would sit next to
  the existing `InfoProvider` (`vscode-lean4/src/infoview.ts`), which already owns
  the webview, the `Rpc`, the `EditorApi` impl, and keepalive.
- **Host role** reuses `LeanClientProvider`/`LeanClient` directly — no `exports`
  indirection, no adapter, no private-field access; `LeanBridgeHost` becomes a
  forwarder over `shareServer`.
- **Guest role** is the real addition: detect the Live Share guest role and,
  instead of refusing to start (no toolchain on the `vsls:` FS), open the existing
  infoview driven by the bridge.
