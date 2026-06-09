# Lean 4 Infoview for VS Code Live Share

Brings the Lean 4 **Infoview** — goals, messages, widgets, and the editor's Lean
gutter decorations — to **guests** in a
[VS Code Live Share](https://visualstudio.microsoft.com/services/live-share/)
session, not just the host.

> **Alpha.** A companion extension implementing
> [vscode-lean4#390](https://github.com/leanprover/vscode-lean4/issues/390)
> without forking VS Code or the Lean server.

<!-- TODO: add a screenshot/GIF of the guest infoview here -->

## Install

Do this on **both** the host and the guest:

1. Download `lean4-live-share-infoview.vsix` from the
   [latest release](https://github.com/Arrow7000/live-share-lean-infoview/releases/latest).
2. In VS Code, open the Command Palette and run **Extensions: Install from VSIX…**,
   then choose the downloaded file.
3. Reload when prompted.

After the first install it keeps itself up to date from new releases (toggle with
`leanLiveShare.autoUpdate.enabled`, or force a check via **Lean Live Share: Check
for Updates**).

### Requirements

Both peers also need two extensions from the Marketplace:

- [**Live Share**](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare)
  — the collaboration session itself.
- [**Lean 4**](https://marketplace.visualstudio.com/items?itemName=leanprover.lean4)
  — the guest needs it too, otherwise shared `.lean` files don't get syntax highlighting.

The **host** additionally opens a Lean project and runs the Lean server; the guest
needs no Lean toolchain or local checkout.

Live Share isn't available in some VS Code forks (e.g. Cursor), so use VS Code —
not a fork — on both sides.

## Usage

1. **Host:** open a `.lean` file (wait for the Lean server to start), then run
   **Live Share: Start Collaboration Session**.
2. **Guest:** join the session, open the shared `.lean` file, and click into a proof.

The **Lean Infoview (Live Share guest)** panel opens automatically and follows
your cursor. Reopen it any time with **Lean Live Share: Open Guest Infoview**. The
**Lean Live Share** output channel (in both windows) shows status if something
looks off.

## What it is

### The problem

Over Live Share, a guest gets the standard editor features (hovers, completion,
diagnostics) but **no Infoview** — the panel showing the proof state at the cursor.
Only the host runs the Lean server, and the Infoview is driven by Lean-specific LSP
requests that Live Share doesn't forward. The guest is effectively proving blind.

### Features

For the guest, driven live by the host's Lean server:

- **Goal state** at the cursor (plus term goals and expected types).
- **Messages, diagnostics, and traces** — the real interactive "All Messages".
- **User widgets** (e.g. ProofWidgets).
- The **Lean editor gutter**: elaboration progress (orange), errors and warnings,
  the blue "goals accomplished" ✓, and the 🛠 unsolved-goals marker.
- Infoview **actions** work: go-to-source, copy-to-comment, apply-edit, restart file.
- The **real** [`@leanprover/infoview`](https://www.npmjs.com/package/@leanprover/infoview)
  UI (not a reimplementation), with correct theme colors and a reopenable panel.

## How it works

The host already runs the Lean server. This extension bridges the Infoview's
Lean-specific RPC between the two peers and renders the real Infoview on the guest:

- The **host** runs a localhost WebSocket server, exposes it to guests with Live
  Share's `shareServer`, and relays the Infoview's RPC to its Lean server (reusing
  vscode-lean4's own client).
- The **guest** hosts the real `@leanprover/infoview` webview and routes its
  requests over that bridge instead of to a local server.

(Live Share's generic `shareService` messaging is allowlist-gated for third-party
extensions, so the transport is a tunnelled port rather than a custom RPC service.)

### Limitations

- **Both peers must have the extension** — a host-only install can't work.
- "Restart File" briefly focuses the file on the host; snippet edits are inserted
  literally (no placeholder expansion); request cancellation isn't forwarded yet.
- To replay state on join, the host reads one private field of vscode-lean4
  (degrades gracefully if it ever changes).
- Tested mainly on macOS.

## Development

```bash
# Headless tests — spawn a real Lean server; no VS Code, no Live Share:
npm install && npm test
```

```bash
# Build the extension + run the webview render test (downloads VS Code once):
cd extension && npm install && npm run build && npm test
```

To test the full end-to-end Live Share flow **on a single machine** — where you
play both the host and the guest in two separate VS Code windows — run:

```bash
./scripts/dev-liveshare.sh
```

It builds the extension, launches two isolated VS Code instances (host + guest)
loading it from source, and prints the steps to follow. The host opens the bundled
fixture project by default; point it at any Lean project instead:

```bash
./scripts/dev-liveshare.sh ../my-lean-proj
# or, equivalently:
PROJECT=../my-lean-proj ./scripts/dev-liveshare.sh
```

To iterate without re-running it: `npm --prefix extension run build`, then
**Developer: Reload Window** in both windows.

## License

Apache-2.0 — see [`LICENSE`](LICENSE). The Lean gutter icons are derived from
[vscode-lean4](https://github.com/leanprover/vscode-lean4) (also Apache-2.0).

## Acknowledgements

Built almost entirely by Claude (an AI coding agent) pair-programming with the
author — from the first headless spike to the working Live Share integration. 🤖
