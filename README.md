# Lean 4 Infoview for VS Code Live Share

Brings the Lean 4 **Infoview** — proof goal state, messages/diagnostics, the blue
"goals accomplished" ✓, and user widgets — to **guests** in a
[VS Code Live Share](https://visualstudio.microsoft.com/services/live-share/)
session, not just the host.

> Status: **alpha / working prototype.** A companion extension that implements
> [vscode-lean4#390](https://github.com/leanprover/vscode-lean4/issues/390)
> without forking VS Code or the Lean server.

<!-- TODO: add a screenshot/GIF of the guest infoview here -->

## The problem

When you pair on Lean 4 over Live Share, the guest gets standard editor features
(hovers, completion, diagnostics) but **no Infoview** — the panel that shows the
proof state at the cursor. Only the host runs the Lean server, and the Infoview is
powered by Lean-specific LSP requests that Live Share doesn't forward. So the
guest is effectively proving blind.

This extension gives the guest a real, live Infoview driven by the host's Lean
server.

## Features

- **Live goal state** at the guest's cursor, updating as they move around.
- **Messages & diagnostics** (the Infoview's "All Messages").
- **Blue "goals accomplished" ✓** in the gutter for completed proofs.
- **User widgets** ride the same channel.
- Correct **theme colors** in the Infoview, and a reopenable panel.
- The real [`@leanprover/infoview`](https://www.npmjs.com/package/@leanprover/infoview)
  — same UI as the host, not a reimplementation.

## Requirements

Installed on **both** peers:

- This extension.
- The [Live Share](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare) extension.

On the **host** only, additionally:

- The [Lean 4](https://marketplace.visualstudio.com/items?itemName=leanprover.lean4)
  extension and an open Lean project (the host runs the actual Lean server).

The guest needs nothing else — no Lean toolchain, no project checkout.

> Note: Live Share is a Microsoft extension that isn't available in some VS Code
> forks (e.g. Cursor). Use VS Code on whichever side runs Live Share.

## Install

Distributed as a `.vsix` via [GitHub Releases](https://github.com/Arrow7000/live-share-lean-infoview/releases/latest)
(no marketplace yet). On both peers:

```bash
code --install-extension lean4-live-share-infoview.vsix
```

(or **Extensions: Install from VSIX…** in the Command Palette). Side-loaded
builds self-update: the extension checks Releases on startup and offers to install
newer builds. Run **Lean Live Share: Check for Updates** to force a check, or set
`leanLiveShare.autoUpdate.enabled: false` to turn it off.

## Usage

1. **Host:** open your Lean project, open a `.lean` file (wait for the Lean server
   to start), then start a Live Share session.
2. **Guest:** join the session, open the shared `.lean` file, and put your cursor
   in a proof. The **"Lean Infoview (Live Share guest)"** panel opens
   automatically and follows your cursor.

Closed the panel? Reopen it with **Lean Live Share: Open Guest Infoview**. The
**"Lean Live Share"** output channel (both windows) shows status and is the first
place to look if something seems off.

## How it works

The host already runs the Lean server. This extension bridges the Infoview's
Lean-specific RPC between the two peers and renders the real Infoview on the guest:

- The **host** exposes a small localhost WebSocket server to guests via Live
  Share's `shareServer`, and relays the Infoview's RPC to its Lean server
  (reusing vscode-lean4's own client).
- The **guest** hosts the real `@leanprover/infoview` webview and routes its
  requests over that bridge instead of to a local server.

Live Share's generic messaging API (`shareService`) is allowlist-gated for
third-party extensions, which is why the transport is a tunneled port rather than
a custom RPC service. Full details, design rationale, and the verified Lean/Live
Share findings are in [`docs/DESIGN.md`](docs/DESIGN.md).

## Limitations

- **Both peers must have the extension** — a host-only install can't work (the
  guest needs something to host the webview and speak the bridge).
- The host reads one private field of vscode-lean4 to replay the "goals
  accomplished" checkmark on join; it degrades gracefully if that ever changes.
- Multi-cursor, selection-aware features, and cross-bridge go-to-definition are
  basic. Cancellation isn't forwarded yet.
- Tested primarily on macOS with a single host project. See `docs/DESIGN.md` for
  the testing matrix.

## Development

```bash
# Headless suite (real Lean server, no VS Code, no Live Share):
npm install && npm test

# Build + the webview render smoke test (downloads VS Code once):
cd extension && npm install && npm run build && npm test
```

To exercise the real Live Share path solo, `./scripts/dev-liveshare.sh` launches
two isolated VS Code instances (host + guest) loading the extension from source;
follow its printed steps. Iterate with `npm --prefix extension run build` then
**Developer: Reload Window** in both.

Architecture, repo layout, the testing strategy, and the Lean/Live Share findings
live in [`docs/DESIGN.md`](docs/DESIGN.md).

## Acknowledgements

Built on [`vscode-lean4`](https://github.com/leanprover/vscode-lean4) and
[`@leanprover/infoview`](https://github.com/leanprover/vscode-lean4/tree/master/lean4-infoview)
(Apache-2.0). The "goals accomplished" gutter icon is derived from vscode-lean4.

## License

Apache-2.0 (consistent with the upstream Lean code this builds on). See
[`LICENSE`](LICENSE).
