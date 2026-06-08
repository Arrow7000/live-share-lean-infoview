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
by hand. It is a solo loop (one machine, join your own session). Watch the
**"Lean Live Share"** output channel in both windows; the extension logs every
step and forwards webview errors there.

1. Build + package the extension:
   ```bash
   cd extension && npm run build
   npx --yes @vscode/vsce package --allow-missing-repository -o lean4-live-share-infoview.vsix
   ```
2. Install it (and the **Live Share** extension, and **lean4** on the host) in both editors.
   Host in Cursor, guest in stock VS Code keeps them distinct:
   ```bash
   cursor --install-extension lean4-live-share-infoview.vsix
   code   --install-extension lean4-live-share-infoview.vsix
   ```
3. **Host:** open the `fixtures/lean-fixture` project (or any Lean project), open a
   `.lean` file so the Lean server starts, then start a Live Share session.
4. **Guest:** join the link, open the shared `.lean` file, and move the cursor into a
   proof. The "Lean Infoview (Live Share guest)" panel should show the goal state.
5. If something is off, run **Lean Live Share: Show Log** in both windows.

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
host→guest server notifications = `service.notify(...)` ↔ `proxy.onNotify(...)`. Since
our companion extension shares its **own** service (same id on host and guest), no
cross-extension name prefixing is needed.

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
