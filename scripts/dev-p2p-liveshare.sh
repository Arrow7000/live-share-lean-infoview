#!/usr/bin/env bash
#
# Launch two isolated Cursor instances on one machine for a solo P2P Live Share
# host+guest test of the Lean infoview bridge.
#
# This is the Cursor + kermanx.p2p-live-share counterpart of dev-liveshare.sh
# (which targets VS Code + Microsoft Live Share). P2P Live Share is an
# open-source alternative that installs from Open VSX, so it works in Cursor and
# other VS Code forks where Microsoft's Live Share is blocked.
#
#   HOST  = isolated user-data-dir, your DEFAULT Cursor extensions (these must
#           include lean4 + P2P Live Share), our extension loaded from source via
#           --extensionDevelopmentPath, opened on the Lean fixture so a Lean
#           server starts.
#   GUEST = fully isolated user-data-dir + extensions-dir (lean4 + P2P Live Share
#           installed into it from Open VSX), our extension loaded from source.
#
# A separate --user-data-dir is what makes each a distinct INSTANCE (own process
# + extension host), which is required to host and join a session as yourself.
#
# ┌─ IMPORTANT CAVEAT ─────────────────────────────────────────────────────────┐
# │ As of now the extension only wires up its host/guest roles through the      │
# │ Microsoft Live Share API (`vsls.getApi()` in extension/src/extension.ts).   │
# │ P2P Live Share does NOT implement that API, so under Cursor the bridge will │
# │ NOT auto-engage yet: you'll get two Cursor windows collaborating via P2P    │
# │ Live Share with our extension loaded, but no Lean infoview on the guest     │
# │ until we add a P2P Live Share adapter. This script is the test harness for  │
# │ that work.                                                                   │
# └────────────────────────────────────────────────────────────────────────────┘
#
# Iterate without re-running this: `npm --prefix extension run build` then run
# "Developer: Reload Window" in both windows.
#
# Usage: scripts/dev-p2p-liveshare.sh [LEAN_PROJECT_DIR]
#
# The HOST window opens LEAN_PROJECT_DIR (a Lean project, so a Lean server
# starts). It defaults to the bundled fixture, but you can point it at any other
# project, e.g.:
#
#   scripts/dev-p2p-liveshare.sh ../lean-experiments/experiments/
#
# This keeps the extension source and the isolated Cursor data dirs anchored to
# THIS repo, while the opened Lean project can live anywhere. You can also set it
# via the PROJECT env var (the positional arg wins if both are given).
#
# Override the editor binary with CODE=... (defaults to `cursor`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/extension"
FIXTURE="$ROOT/fixtures/lean-fixture"
DEV="$ROOT/.dev-instances"
HOST_DATA="$DEV/host-data-p2p"
GUEST_DATA="$DEV/guest-data-p2p"
GUEST_EXT="$DEV/guest-ext-p2p"
CODE="${CODE:-cursor}"

# The Lean project the HOST opens. Resolve relative paths against the caller's
# CWD (not the repo root) so `../lean-experiments/experiments/` works as typed.
PROJECT="${1:-${PROJECT:-$FIXTURE}}"
if [ ! -d "$PROJECT" ]; then
  echo "error: Lean project dir not found: '$PROJECT'" >&2
  exit 1
fi
PROJECT="$(cd "$PROJECT" && pwd)"

if ! command -v "$CODE" >/dev/null 2>&1; then
  echo "error: '$CODE' CLI not found on PATH. In Cursor run 'Shell Command: Install 'cursor' command in PATH' (or set CODE=...)." >&2
  exit 1
fi

echo "==> Building the extension (esbuild + assets)..."
( cd "$EXT_DIR" && npm install --silent && npm run build )

mkdir -p "$HOST_DATA" "$GUEST_DATA" "$GUEST_EXT"

ensure_ext() {
  # ensure_ext <extensions-dir> <user-data-dir> <extension-id> <match>
  if "$CODE" --extensions-dir "$1" --user-data-dir "$2" --list-extensions 2>/dev/null | grep -qi "$4"; then
    echo "    already present: $3"
  else
    echo "==> Installing $3 into guest instance (from Open VSX)..."
    "$CODE" --extensions-dir "$1" --user-data-dir "$2" --install-extension "$3"
  fi
}

# The guest needs P2P Live Share (to join) and lean4 (so the shared .lean file
# gets the 'lean4' language id; it stays in restricted mode and does NOT run a
# server). Both resolve from Cursor's Open VSX registry.
ensure_ext "$GUEST_EXT" "$GUEST_DATA" "kermanx.p2p-live-share" "p2p-live-share"
ensure_ext "$GUEST_EXT" "$GUEST_DATA" "leanprover.lean4" "lean4"

echo "==> Launching HOST window on: $PROJECT"
echo "    (open a .lean file, then P2P Live Share: Host a Session)..."
"$CODE" --user-data-dir "$HOST_DATA" --extensionDevelopmentPath "$EXT_DIR" --new-window "$PROJECT"

echo "==> Launching GUEST window (P2P Live Share: Join a Session, paste link, open the .lean file)..."
"$CODE" --user-data-dir "$GUEST_DATA" --extensions-dir "$GUEST_EXT" --extensionDevelopmentPath "$EXT_DIR" --new-window

cat <<'STEPS'

────────────────────────────────────────────────────────────────────────────
Two Cursor windows should now be opening. Then:

HOST window (opened on the Lean project printed above):
  1. Open a .lean file and wait for the Lean server (✓ in the status bar).
  2. Command Palette → "P2P Live Share: Host a Session". The invite link is
     copied to your clipboard (or use the P2P Live Share panel in the Activity
     Bar → "Copy Invite Link").

GUEST window (blank):
  3. Command Palette → "P2P Live Share: Join a Session" and PASTE the link.
  4. In the shared file tree, open the same .lean file and click inside a proof.

NOTE: until the extension grows a P2P Live Share adapter, the guest infoview
will NOT appear (the extension only auto-wires through Microsoft Live Share's
`vsls` API, which P2P Live Share does not implement). See the caveat at the top
of this script. P2P Live Share's own editor/cursor sharing will work regardless.

Diagnostics: in BOTH windows, Command Palette → "Lean Live Share: Show Log".

Iterate: `npm --prefix extension run build`, then "Developer: Reload Window" in
both windows (no need to re-run this script).
────────────────────────────────────────────────────────────────────────────
STEPS
