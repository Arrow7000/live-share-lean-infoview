#!/usr/bin/env bash
#
# Launch two isolated VS Code instances on one machine for a solo Live Share
# host+guest test of the Lean infoview bridge.
#
#   HOST  = isolated user-data-dir, your DEFAULT extensions (lean4 + Live Share),
#           our extension loaded from source via --extensionDevelopmentPath,
#           opened on the Lean fixture so a Lean server starts.
#   GUEST = fully isolated user-data-dir + extensions-dir (lean4 + Live Share
#           installed into it), our extension loaded from source.
#
# A separate --user-data-dir is what makes each a distinct INSTANCE (own process
# + extension host), which is required to host and join Live Share as yourself.
#
# Iterate without re-running this: `npm --prefix extension run build` then run
# "Developer: Reload Window" in both windows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/extension"
FIXTURE="$ROOT/fixtures/lean-fixture"
DEV="$ROOT/.dev-instances"
HOST_DATA="$DEV/host-data"
GUEST_DATA="$DEV/guest-data"
GUEST_EXT="$DEV/guest-ext"
CODE="${CODE:-code}"

if ! command -v "$CODE" >/dev/null 2>&1; then
  echo "error: '$CODE' CLI not found on PATH. In VS Code run 'Shell Command: Install code command in PATH'." >&2
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
    echo "==> Installing $3 into guest instance..."
    "$CODE" --extensions-dir "$1" --user-data-dir "$2" --install-extension "$3"
  fi
}

# The guest needs Live Share (to join) and lean4 (so the shared .lean file gets
# the 'lean4' language id; it stays in restricted mode and does NOT run a server).
ensure_ext "$GUEST_EXT" "$GUEST_DATA" "ms-vsliveshare.vsliveshare" "vsliveshare"
ensure_ext "$GUEST_EXT" "$GUEST_DATA" "leanprover.lean4" "lean4"

echo "==> Launching HOST window (open a .lean file, then Live Share: Start)..."
"$CODE" --user-data-dir "$HOST_DATA" --extensionDevelopmentPath "$EXT_DIR" --new-window "$FIXTURE"

echo "==> Launching GUEST window (Live Share: Join, paste link, open the .lean file)..."
"$CODE" --user-data-dir "$GUEST_DATA" --extensions-dir "$GUEST_EXT" --extensionDevelopmentPath "$EXT_DIR" --new-window

cat <<'STEPS'

────────────────────────────────────────────────────────────────────────────
Two VS Code windows should now be opening. Then:

HOST window (opened on fixtures/lean-fixture):
  1. Open Fixture.lean and wait for the Lean server (✓ in the status bar).
  2. Command Palette → "Live Share: Start Collaboration Session". The join link
     is copied to your clipboard.

GUEST window (blank):
  3. Command Palette → "Live Share: Join Collaboration Session..." and PASTE the
     link. (Use the command — don't click the link, or it may route to the wrong
     instance.) Sign in if asked; the SAME account as the host is fine.
  4. In the shared file tree, open Fixture.lean and click inside the proof
     (the `exact` line). The "Lean Infoview (Live Share guest)" panel should show
     the goal `⊢ p ∧ q`.

Diagnostics: in BOTH windows, Command Palette → "Lean Live Share: Show Log".
The host logs bridge/keepalive activity; the guest logs the webview lifecycle
and forwards any webview errors.

Iterate: `npm --prefix extension run build`, then "Developer: Reload Window" in
both windows (no need to re-run this script).
────────────────────────────────────────────────────────────────────────────
STEPS
