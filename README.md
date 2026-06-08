# Lean 4 Infoview over VS Code / Cursor Live Share

Make the Lean 4 **Infoview** work for a **guest** in a Live Share session, not just
the host. This is a companion extension (installed by both host and guest) plus a
**transport-agnostic bridge**, built without forking VS Code or the Lean server.
It is a working prototype of [`vscode-lean4#390`](https://github.com/leanprover/vscode-lean4/issues/390).

See `HANDOVER` (the originating design doc) for the full plan. This README tracks
**verified findings** and how to run the current code.

## Status

| Milestone | Description | State |
| --- | --- | --- |
| M0 | Baseline repro (manual two-window smoke) | manual |
| **M1** | **Headless host-RPC spike** | ✅ **done & green** |
| **M0.5** | **`shareService` whitelist smoke test** (extension built; needs a manual two-window run) | ⏳ awaiting manual run |
| **M2** | **Host bridge over fake transport (loopback / WebSocket)** | ✅ **done & green** |
| **M3** | **Guest Infoview rendering** (real infoview in a real VS Code webview) | ✅ **done & green** (Electron render test) |
| **M4** | **Real Live Share transport + host/guest wiring** | ✅ machine-testable parts green; ⏳ end-to-end needs a manual two-window run |
| M5 | Hardening (multi-project clients, widgets, cancellation, multiple guests) | not started |

> **Transport note (confirmed by manual test 2026-06-08):** Live Share **gates
> `shareService`/`getSharedService`** to an allowlist — they return `null` for a
> third-party extension (exactly the vscode-lean4#390 concern). So the bridge
> transports over **`shareServer(port)` + WebSocket** instead, which is *not*
> gated (no "may be restricted" note in the vsls API): the host runs a localhost
> WebSocket server and shares its port; the guest connects to that port (derived
> deterministically from the session id, so no `shareService` is needed to agree
> on it). This is why the transport was kept abstract — only the adapter changed.

**Machine-verified end to end (no Live Share, no human):** the Lean custom RPC,
the host bridge over loopback/WebSocket against a *real* Lean server, the full
guest data path (webview `EditorApi` → RPC → bridge → real Lean), the real
infoview *rendering* a captured goal in a real VS Code webview, the
`LiveShareChannel` against a faithful vsls mock, and URI translation. The only
unverified-by-machine piece is Live Share's own session plumbing — see the
manual two-window test below.

> **M0.5 (why it exists):** [vscode-lean4#390](https://github.com/leanprover/vscode-lean4/issues/390)
> has a maintainer comment suspecting Live Share's protocol extensibility is
> whitelisted. Our approach only needs the *generic* `shareService` messaging
> (not Live Share's native LSP relay), so `experiments/vsls-smoke/` is a tiny
> throwaway that confirms a non-whitelisted extension can do a host↔guest
> `shareService` round-trip. It needs a manual two-window run (see its README).
> If it ever fails, the bridge's `shareServer(port)` + `WebSocketChannel` path is
> the fallback.

## Install the extension (alpha)

Distributed as a `.vsix` via **GitHub Releases** — no marketplace yet. Install it
on **both** peers (host and guest).

1. Grab `lean4-live-share-infoview.vsix` from the
   [latest release](https://github.com/Arrow7000/live-share-lean-infoview/releases/latest).
2. **Extensions: Install from VSIX…** (Command Palette), or
   `code --install-extension lean4-live-share-infoview.vsix`.

**Auto-update:** a side-loaded `.vsix` normally never updates itself (VS Code /
Cursor only auto-update gallery extensions), so this extension does it manually:
on startup it checks GitHub Releases and, if a newer build exists, downloads +
installs it and offers a reload. Run **Lean Live Share: Check for Updates** to
force a check, or set `leanLiveShare.autoUpdate.enabled: false` to disable.

**How releases are cut:** [`.github/workflows/release.yml`](.github/workflows/release.yml)
runs on every push to `main` (and via *Run workflow*): it builds, stamps the
version `0.0.<unix-seconds>` (so the newest build is always the highest version —
no manual semver during alpha), packages the `.vsix`, and publishes it as the
"latest" release.

## Prerequisites

- Node ≥ 22 (uses the built-in test runner; developed on v23).
- `elan` / `lake` on `PATH` (developed on Lean `v4.30.0`, Lake `5.0.0`).

## Running

```bash
npm install

# M1 spike, human-readable output (spawns a real Lean server on the fixture):
npm run spike:m1

# M1 as the permanent integration test:
npm run test:m1
# or the whole suite:
npm test
```

The fixture is a zero-import Lean project at `fixtures/lean-fixture/` so no
`lake build` / network is needed; `lake serve --` (or a `lean --server` fallback)
elaborates it in ~1s.

### The companion extension

```bash
cd extension
npm install
npm run build          # esbuild: extension + webview bundles, copies infoview assets
npm test               # @vscode/test-electron render smoke test (downloads VS Code once)
```

`npm test` launches a real VS Code, renders a captured goal in the real
`@leanprover/infoview` webview, and asserts (via the infoview's own
`getInfoviewHtml`) that the goal was drawn.

### Manual two-window end-to-end test (the only human step)

Live Share needs an interactive sign-in, so the true host+guest path is checked
by hand. It is a solo loop on one machine. **Cursor can't run Live Share**, and
two windows of the *same* VS Code share one instance/auth — so we use two
**isolated** VS Code instances (each gets its own `--user-data-dir`, which is
what makes them distinct processes).

```bash
./scripts/dev-liveshare.sh
```

This builds the extension, provisions an isolated guest instance (installs Live
Share + lean4 into it), and launches a host window (your default extensions +
the Lean fixture) and a guest window, both loading the extension from source via
`--extensionDevelopmentPath`. Then follow the printed steps: host opens
`Fixture.lean` and starts a session; guest joins via the command palette, opens
the shared file, and clicks into the proof — the "Lean Infoview (Live Share
guest)" panel should show `⊢ p ∧ q`.

Watch the **"Lean Live Share"** output channel in both windows (the host logs
bridge/keepalive activity; the guest logs the webview lifecycle and forwards
webview errors). Iterate with `npm --prefix extension run build` + "Developer:
Reload Window" in both. A packaged `.vsix` (`npx @vscode/vsce package`) also
works if you prefer installing into a real instance.

## Layout

```
fixtures/lean-fixture/      one-theorem Lean project with a deterministic goal
src/lean-rpc/
  leanRpcTypes.ts           wire types + method-name constants + TaggedText flatten
  leanServerConnection.ts   headless LSP + custom-RPC client over a spawned server
  fixtureServer.ts          shared: launch + elaborate the fixture, resolve goal pos
  m1-spike.ts               M1 orchestration (also a CLI)
src/bridge/                 the transport-agnostic bridge (M2/M4)
  types.ts                  BridgeChannel + LeanClientLike + bridge protocol
  loopbackChannel.ts        in-process channel (JSON round-trips to mimic the wire)
  webSocketChannel.ts       localhost socket channel (also prod via shareServer)
  liveShareChannel.ts       BridgeChannel over vsls shareService/getSharedService
  uriTranslation.ts         pure vsls:<->file: remapping + translating host channel
  leanBridgeHost.ts         host side: relay rpc/*, own keepalive, fan out notifs
  guestEditorClient.ts      guest side: EditorApi-shaped client over a channel
src/infoview/               webview glue (M3), framework-agnostic + testable
  api.ts                    EditorApi / InfoviewApi / EditorRpcApi types
  rpc.ts                    webview<->host postMessage RPC + editorApiOfRpc
  guestEditorApi.ts         guest EditorRpcApi impl backed by GuestEditorClient
extension/                  the companion VS Code extension (M3/M4)
  esbuild.mjs               builds extension (node) + webview (browser) + assets
  webview/main.ts           re-hosts @leanprover/infoview via loader + importmap
  src/infoviewWebview.ts    host-side webview manager (Rpc + InfoviewApi proxy)
  src/leanClientAdapter.ts  vscode-lean4 LeanClient -> LeanClientLike
  src/hostRole.ts           host wiring (lean4 exports -> LeanBridgeHost over vsls)
  src/guestRole.ts          guest wiring (infoview + cursor driver over vsls)
  src/replayEditor.ts       serves the golden payload (for the render test)
  test/                     @vscode/test-electron render smoke test
experiments/vsls-smoke/     M0.5 throwaway: manual shareService two-window probe
test/                       headless tests (no VS Code, no Live Share)
  lean-rpc.integration.test.ts   M1 (real server, custom RPC)
  bridge.unit.test.ts            M2 logic, stub client, BOTH transports (fast)
  bridge.loopback.test.ts        M2 real server behind bridge over loopback
  bridge.websocket.test.ts       M2 real server behind bridge over sockets
  guest-chain.test.ts            M3 full guest path minus render, real server
  liveShareChannel.test.ts       M4 LiveShareChannel over a faithful vsls mock
  uriTranslation.test.ts         M4 vsls:<->file: remapping
  support/driveGoals.ts          shared "show goals" driver
reference/vscode-lean4/     upstream clone, read-only, git-ignored
```

`leanServerConnection.ts` is deliberately reusable: the host bridge does the same
thing — forward `$/lean/rpc/*` to a real Lean server and own keepalive. The host
bridge depends only on `BridgeChannel` + `LeanClientLike`, so it runs identically
over loopback, WebSocket, or (later) Live Share, and is fully testable with a real
Lean server but no VS Code.

---

## Verified findings (corrections to the handover's §1 / confidence map)

Verified against `reference/vscode-lean4` (shallow clone of `leanprover/vscode-lean4`,
package versions: extension uses `@leanprover/infoview` 0.13.0) and the live server
(`Lean 4 Server 0.3.0`, toolchain `v4.30.0`) via the M1 spike.

### Custom RPC — was [UNVERIFIED], now **[CONFIRMED]**

LSP wire methods (sent as ordinary LSP requests/notifications to the Lean server):

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `$/lean/rpc/connect` | request | `{ uri }` | `{ sessionId: string }` |
| `$/lean/rpc/call` | request | `{ sessionId, method, params, textDocument:{uri}, position }` | method-specific |
| `$/lean/rpc/keepAlive` | notification | `{ uri, sessionId }` | — |
| `$/lean/rpc/release` | notification | `{ uri, sessionId, refs }` | — |
| `$/lean/fileProgress` | server→client notif | `{ textDocument:{uri,version}, processing: [...] }` | — |
| `textDocument/publishDiagnostics` | server→client notif | standard (+ Lean `fullRange`, `leanTags`) | — |

`params` inside `$/lean/rpc/call` for the goal/widget methods is itself a
`TextDocumentPositionParams` (`{ textDocument:{uri}, position }`) for goal queries.

Goal/widget method strings passed *inside* `$/lean/rpc/call` — the handover's
guesses were **correct**:

- `Lean.Widget.getInteractiveGoals` — params `TDPP`, result `{ goals: InteractiveGoal[] }`
- `Lean.Widget.getInteractiveTermGoal`
- `Lean.Widget.getInteractiveDiagnostics` — params `{ lineRange? }`
- `Lean.Widget.getWidgets` / `Lean.Widget.getWidgetSource`
- plus `getGoToLocation`, `InteractiveDiagnostics.{msgToInteractive,infoToInteractive}`,
  `lazyTraceChildrenToInteractive`, `highlightMatches`.

Empirically confirmed: at the start of the `exact` line in the fixture,
`getInteractiveGoals` returns exactly one goal rendering as:

```
p q : Prop
hp : p
hq : q
⊢ p ∧ q
```

with a ~1ms round-trip once elaboration is done.

### RPC keepalive interval — was [UNVERIFIED], now **[CONFIRMED]**

`keepAlivePeriodMs = 10000` (10s), from `vscode-lean4/src/infoview.ts`. **The editor
(extension), not the infoview, owns keepalive** — the `EditorApi` doc says the
infoview can't reliably `setInterval` when the window is hidden. → In the bridge,
**the host side must own keepalive per guest session.**

### RPC wire format — new finding

The 4.30.0 server advertises
`experimental.rpcProvider.rpcWireFormat = "v1"`, where RPC references are
`{ "__rpcref": "<string>" }` (older `v0` used `{ "p": "<string>" }`). The bridge
forwards these as **opaque JSON**, so it needs no special handling — but it **must
forward `$/lean/rpc/release`** (guest→host) so server-side refs get GC'd.

### Does `vscode-lean4` export a handle to its `LeanClient`? — the pivotal unknown: **YES. No fork needed. [CONFIRMED]**

`activate()` returns `Promise<Exports>` (`src/extension.ts`, `src/exports.ts`):

```ts
class Exports {
  alwaysEnabledFeatures: AlwaysEnabledFeatures
  lean4EnabledFeatures: Promise<Lean4EnabledFeatures> // { clientProvider, infoProvider, projectOperationProvider }
  allFeatures(): Promise<EnabledFeatures>
}
```

So a companion extension can do:

```ts
const ext = vscode.extensions.getExtension('leanprover.lean4')!
const exports = await ext.activate()                  // Exports
const { clientProvider } = await exports.lean4EnabledFeatures
const client = clientProvider.findClient(extUri)      // LeanClient | undefined
```

`LeanClient` exposes the public surface we need:

- `sendRequest(method, params, token?)` and `sendNotification(method, params)` — used to relay `$/lean/rpc/*`.
- Events: `diagnostics` (`LeanPublishDiagnosticsParams`), `customNotification` (`{method, params}` — fires for `$/lean/fileProgress` and other `$/lean/*`), `progressChanged`, `restarted`, `stopped`, `didChange`, `didClose`.

`LeanClientProvider` exposes `findClient(uri)`, `getClients()`, `getClientForFolder(folder)`,
`ensureClient(uri)`, and a `clientAdded` event.

### `EditorApi` / `InfoviewApi` — was [LIKELY], now **[CONFIRMED]**

Defined in `@leanprover/infoview-api` (`infoviewApi.ts`). The infoview talks to its
host editor only through `EditorApi`; the relevant methods to re-implement on the
guest are: `sendClientRequest(uri, method, params, opts)`,
`sendClientNotification(uri, method, params)`, `subscribe/unsubscribe{Server,Client}Notifications(method)`,
`createRpcSession(uri)` / `closeRpcSession(id)`, `insertText`, `applyEdit`, `showDocument`, `saveConfig`, `copyToClipboard`, `restartFile`.

The infoview builds its `RpcServerIface` *on top of* `EditorApi`
(`lean4-infoview/src/infoview/rpcSessions.tsx`): RPC calls are just
`sendClientRequest(uri, '$/lean/rpc/call', params)`, and release is
`sendClientNotification(uri, '$/lean/rpc/release', params)`. → **The seam we
re-implement for the guest is exactly `EditorApi`.**

The webview↔extension transport is a small `seqNum`-based JSON-RPC (`vscode-lean4/src/rpc.ts`),
with `sendClientRequest` split into `startClientRequest`/`awaitClientRequest`/`cancelClientRequest`
for cancellation (the `EditorRpcApi` type).

### Infoview loader — was [LIKELY], now **[CONFIRMED]**

`@leanprover/infoview` (npm, ESM, `"type": "module"`) exposes two entrypoints:
`.` (the React app, `renderInfoview(...)`, must **not** be transpiled to UMD) and
`./loader` (`loadRenderInfoview(imports, args, next)`), which sets up an `importmap`
via `es-module-shims` and dynamically imports the app. Use the loader path.

### Live Share API + URI conversion — was [LIKELY], now **[CONFIRMED]**

From the `vsls` package type defs (`node_modules/vsls/vscode.ts`):

- `getApi(callingExtensionId?): Promise<LiveShare | null>`.
- `shareService(name): Promise<SharedService|null>` — host. `SharedService` has
  `onRequest(name, handler)`, `onNotify(name, handler)`, `notify(name, args: object)`.
- `getSharedService(name): Promise<SharedServiceProxy|null>` — guest.
  `SharedServiceProxy` has `request(name, args: any[], cancellation?)`,
  `onNotify(name, handler)`, `notify(name, args)`.
- **URI conversion exists**: `convertLocalUriToShared(localUri: Uri): Uri` and
  `convertSharedUriToLocal(sharedUri: Uri): Uri` (synchronous).
- `session: Session` (role/peer/access), `onDidChangeSession`, `peers: Peer[]`,
  `onDidChangePeers`, `shareServer(server): Promise<Disposable>`.

Mapping onto the bridge: guest→host RPC = `proxy.request(...)` ↔ `service.onRequest(...)`;
host→guest server notifications = `service.notify(...)` ↔ `proxy.onNotify(...)`.

**However — corrected by the manual test (2026-06-08):** `shareService` /
`getSharedService` are **gated by Live Share to an allowlist** and return `null`
for a third-party extension. The vsls API docs admit this ("Access to shared
services may be restricted. If the caller is not permitted, this method returns
`null`"), and the host log confirmed it (`shareService returned null`). This is
the precise blocker mhuisi described in #390. The `LiveShareChannel` adapter and
its mock test remain valid, but are **not usable in practice**.

**The working transport is `shareServer(port)` + WebSocket**, which carries *no*
restriction note in the vsls API. The host runs a localhost WebSocket server and
calls `shareServer({ port })`; the guest connects to `ws://127.0.0.1:<port>`.
The port is derived from `session.id` (identical on both peers) so no gated
channel is needed to exchange it. On one machine the guest reaches the host's
server directly; across machines Live Share tunnels the port.

---

## Next steps (M5 — hardening)

- Per-URI client resolution on the host (multiple Lean projects / clients), instead
  of "first client".
- User widgets (ProofWidgets): `getWidgets`/`getWidgetSource` are ordinary calls over
  the same pipe and should already work; confirm a `@[widget_module]` renders on the guest.
- Real request cancellation (forward `$/cancelRequest` over the bridge).
- Multiple guests (one RPC session each) and reconnect/restart handling.
- Diagnostics replay on (re)connect; client-notification echoes if needed.

## Could this be upstreamed into vscode-lean4 instead of a separate extension?

Yes — and that's arguably the ideal. The standalone design was chosen for
iteration speed, but nothing here requires being separate; **it does require the
extension to be installed on BOTH peers** (the guest needs *some* extension to
host the webview and speak the bridge — a host-only install can't work, exactly
as the #390 comment notes). The pieces map cleanly onto upstream:

- `src/bridge/*` and `src/infoview/{rpc,api,guestEditorApi}.ts` would live next to
  the existing `InfoProvider` (`vscode-lean4/src/infoview.ts`), which already owns
  the webview, the `Rpc`, the `EditorApi` impl, and keepalive.
- The **host role** reuses the existing `LeanClientProvider`/`LeanClient` directly
  (no exports indirection, no adapter) — `LeanBridgeHost` becomes a forwarder
  registered on a `shareService`.
- The **guest role** is the bigger change: today the guest's `vscode-lean4` refuses
  to start (no toolchain on the `vsls:` FS). Upstream would detect the Live Share
  guest role and, instead of starting a server, open the existing infoview webview
  driven by the bridge — i.e. an alternate `EditorApi` whose RPC goes over `vsls`
  rather than to a local `LanguageClient`.
- URI translation and the vsls dependency would be gated behind the guest path.

In short: the host side is a small addition; the guest side is a new "no local
server, drive the infoview over Live Share" mode. This repo is structured to make
that port mechanical (the transport-agnostic seam is already the same `EditorApi`
upstream uses). See the chat handoff for the detailed file-by-file plan.
