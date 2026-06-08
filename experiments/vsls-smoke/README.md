# VSLS Smoke Probe (M0.5)

A throwaway diagnostic extension that answers the **one** question M1 couldn't:

> Can a *non-whitelisted* third-party extension use Live Share's generic
> `shareService` / `getSharedService` messaging to do a host↔guest RPC
> round-trip?

This is the load-bearing assumption behind the whole "Lean Infoview over Live
Share" approach. A `vscode-lean4` maintainer
([#390 comment](https://github.com/leanprover/vscode-lean4/issues/390#issuecomment-2808923544))
suspected Live Share's protocol extensibility is whitelisted. Our architecture
only needs the *generic* messaging API (not Live Share's native LSP relay), and
the `vsls` docs describe `shareService` as the normal extensibility mechanism —
so this probe confirms it empirically.

## What it does

On activation it grabs the Live Share API and, based on the session role:

- **Host** → `shareService('pingService')` and registers an `echo` request handler.
- **Guest** → `getSharedService('pingService')`, then sends an `echo` request and
  logs the round-trip latency.

Everything (including any `null`/throw that would indicate gating) is logged to
the **"VSLS Smoke"** output channel in both windows, and the guest pops a toast
on success/failure.

## Build

```bash
cd experiments/vsls-smoke
npm install
npm run compile
```

## Run the two-window test (solo, same machine)

You need the **Live Share** extension installed in both editors, and this probe
installed in both. Per the handover, host in Cursor + guest in stock VS Code
keeps the windows distinct.

1. Package it once:
   ```bash
   npx --yes @vscode/vsce package --allow-missing-repository -o vsls-smoke-probe.vsix
   ```
2. Install in both editors:
   ```bash
   code   --install-extension vsls-smoke-probe.vsix
   cursor --install-extension vsls-smoke-probe.vsix
   ```
   (Reload each window after installing.)
3. In the **host** window: start a Live Share session (it does not need a Lean
   project for this probe — any folder works).
4. In the **guest** window: join the link (joining your own session is fine).
5. Watch the **"VSLS Smoke"** output channel in both. If you don't see the guest
   probe fire automatically, run `VSLS Smoke: Run Probe` from the guest's command
   palette.

### Reading the result

- ✅ `GUEST: ✅ ROUND-TRIP OK in <n>ms` → `shareService` works for us; the approach
  is unblocked. Proceed with `LiveShareChannel`.
- ❌ `shareService appears GATED` / `getSharedService ... null` / a thrown error →
  `shareService` is restricted. Fall back to the `shareServer(port)` transport
  (tunnel the host's WebSocket bridge port to guests) — a separate probe.

> Alternative to packaging: press **F5** in this folder to launch an Extension
> Development Host with the probe loaded. You still need the probe present in a
> second window to play the other role, so the package+install route is simpler
> for a solo two-window test.
