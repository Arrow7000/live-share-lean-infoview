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
| M0 | Baseline repro (manual two-window smoke) | not started |
| **M1** | **Headless host-RPC spike** | ✅ **done & green** |
| M2 | Host bridge over fake transport (loopback / WebSocket) | not started |
| M3 | Guest Infoview rendering | not started |
| M4 | Real Live Share transport | not started |
| M5 | Hardening | not started |

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

## Layout

```
fixtures/lean-fixture/      one-theorem Lean project with a deterministic goal
src/lean-rpc/
  leanRpcTypes.ts           wire types + method-name constants + TaggedText flatten
  leanServerConnection.ts   headless LSP + custom-RPC client over a spawned server
  m1-spike.ts               M1 orchestration (also a CLI)
test/lean-rpc.integration.test.ts   M1 assertions
reference/vscode-lean4/     upstream clone, read-only, git-ignored
```

`leanServerConnection.ts` is deliberately reusable: the **host bridge** (M2) does
the same thing — forward `$/lean/rpc/*` to a real Lean server and own keepalive.

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

## Next steps (M2)

Define the `BridgeChannel` interface, implement `LoopbackChannel` + `WebSocketChannel`,
and build the host bridge service against it — reusing `leanServerConnection.ts` for
the real-server path. The host bridge handles: `connect`/`call`/`keepAlive`/`release`
forwarding, per-guest keepalive ownership, server-notification fan-out
(`$/lean/fileProgress`, diagnostics), and `vsls:`↔`file:` URI translation (deferred to
M4 when real `vsls:` URIs appear).
