# Lean 4 Infoview for Live Share

Companion VS Code / Cursor extension that makes the Lean 4 **Infoview** work for
a **guest** in a Live Share session, not just the host. Install it on **both**
peers (host and guest). It is a working prototype of
[`vscode-lean4#390`](https://github.com/leanprover/vscode-lean4/issues/390).

> **Alpha.** Distributed as a `.vsix` via GitHub Releases (not a marketplace).

## Install

1. Download the latest `lean4-live-share-infoview.vsix` from the
   [Releases page](https://github.com/Arrow7000/live-share-lean-infoview/releases/latest).
2. In VS Code / Cursor: **Extensions: Install from VSIX…** (Command Palette) and
   pick the file — or `code --install-extension lean4-live-share-infoview.vsix`.

## Updating

The extension **updates itself**. On startup it checks GitHub Releases and, if a
newer build exists, downloads and installs it, then offers to reload. The most
recently published release is always treated as the latest version.

- Force a check now: **Lean Live Share: Check for Updates** (Command Palette).
- Turn it off: set `leanLiveShare.autoUpdate.enabled` to `false`.

## Commands

| Command | Description |
| --- | --- |
| `Lean Live Share: Open Guest Infoview` | Reopen the guest infoview panel. |
| `Lean Live Share: Show Log` | Show the "Lean Live Share" output channel. |
| `Lean Live Share: Check for Updates` | Check GitHub Releases for a newer build. |

See the [repository README](https://github.com/Arrow7000/live-share-lean-infoview)
for the design, status, and how the bridge works.
