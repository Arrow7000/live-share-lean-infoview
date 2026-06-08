import * as vscode from 'vscode'
import * as vsls from 'vsls'

/**
 * VSLS Smoke Probe — the one un-automatable check, made as small as possible.
 *
 * Question being answered: can a *non-whitelisted* third-party extension use
 * Live Share's generic `shareService` / `getSharedService` messaging to do a
 * host<->guest RPC round-trip? This is the single load-bearing assumption of
 * the Lean-Infoview-over-Live-Share project (see issue leanprover/vscode-lean4#390,
 * where a maintainer suspected this is blocked by a whitelist).
 *
 * How to run: see README.md (two windows, same machine, join your own session).
 * Watch the "VSLS Smoke" output channel in BOTH windows.
 */

const SERVICE_NAME = 'pingService'
const REQUEST_NAME = 'echo'

let out: vscode.OutputChannel
let api: vsls.LiveShare | null = null
let lastProxy: vsls.SharedServiceProxy | null = null

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  out.appendLine(line)
  console.log(`[vsls-smoke] ${line}`)
}

export async function activate(context: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel('VSLS Smoke')
  context.subscriptions.push(out)
  out.show(true)

  context.subscriptions.push(
    vscode.commands.registerCommand('vslsSmoke.showLog', () => out.show(true)),
    vscode.commands.registerCommand('vslsSmoke.runProbe', () => void runGuestProbe('manual command')),
  )

  log('activating; acquiring Live Share API...')
  try {
    // Passing the calling extension id is what a whitelist check (if any) keys on.
    api = await vsls.getApi(context.extension?.id ?? 'live-share-lean-infoview.vsls-smoke-probe')
  } catch (e) {
    log(`getApi() THREW: ${describe(e)}  <-- this itself would indicate gating`)
    return
  }
  if (!api) {
    log('getApi() returned null (Live Share extension not installed or extensibility disabled).')
    return
  }
  log('got Live Share API.')

  context.subscriptions.push(api.onDidChangeSession(e => void onSession(e.session)))
  context.subscriptions.push(
    api.onDidChangePeers(e =>
      log(`peers changed: +${e.added.length} -${e.removed.length} (now ${api?.peers.length} peers)`),
    ),
  )
  await onSession(api.session)
}

async function onSession(session: vsls.Session) {
  const roleName = vsls.Role[session.role]
  log(`session: role=${roleName} id=${session.id ?? 'none'} peer=${session.peerNumber}`)
  if (!api) return
  if (session.role === vsls.Role.Host) {
    await setupHost()
  } else if (session.role === vsls.Role.Guest) {
    await setupGuest()
  } else {
    log('no active session yet. Host: share a session. Guest: join the link.')
  }
}

async function setupHost() {
  if (!api) return
  log(`HOST: calling shareService('${SERVICE_NAME}')...`)
  let service: vsls.SharedService | null
  try {
    service = await api.shareService(SERVICE_NAME)
  } catch (e) {
    log(`HOST: shareService() THREW: ${describe(e)}  <-- shareService appears GATED`)
    return
  }
  if (!service) {
    log('HOST: shareService() returned null  <-- shareService appears GATED/unavailable for this extension')
    return
  }
  log(`HOST: shareService OK. isServiceAvailable=${service.isServiceAvailable}`)

  service.onDidChangeIsServiceAvailable(avail => log(`HOST: service availability -> ${avail}`))
  service.onNotify('hello', (args: object) => log(`HOST: got notify 'hello': ${JSON.stringify(args)}`))
  service.onRequest(REQUEST_NAME, (args: any[]) => {
    log(`HOST: got request '${REQUEST_NAME}' args=${JSON.stringify(args)}`)
    const payload = args?.[0] ?? {}
    return { ...payload, echoedBy: 'host', echoedAt: Date.now() }
  })
  log("HOST: ready. Now run 'VSLS Smoke: Run Probe' in the GUEST window (or it auto-runs when the service becomes available).")
}

async function setupGuest() {
  if (!api) return
  log(`GUEST: calling getSharedService('${SERVICE_NAME}')...`)
  let proxy: vsls.SharedServiceProxy | null
  try {
    proxy = await api.getSharedService(SERVICE_NAME)
  } catch (e) {
    log(`GUEST: getSharedService() THREW: ${describe(e)}  <-- appears GATED`)
    return
  }
  if (!proxy) {
    log('GUEST: getSharedService() returned null  <-- appears GATED/unavailable')
    return
  }
  lastProxy = proxy
  log(`GUEST: getSharedService OK. isServiceAvailable=${proxy.isServiceAvailable}`)
  proxy.onDidChangeIsServiceAvailable(avail => {
    log(`GUEST: service availability -> ${avail}`)
    if (avail) void runGuestProbe('service-available')
  })
  if (proxy.isServiceAvailable) void runGuestProbe('already-available')
}

async function runGuestProbe(trigger: string) {
  if (!lastProxy) {
    log(`GUEST: probe (${trigger}) skipped — no proxy yet (are you the guest, with the host sharing?).`)
    return
  }
  if (!lastProxy.isServiceAvailable) {
    log(`GUEST: probe (${trigger}) skipped — service not available yet.`)
    return
  }
  const sentAt = Date.now()
  const payload = { msg: 'ping from guest', sentAt, trigger }
  log(`GUEST: sending request '${REQUEST_NAME}' (${trigger})...`)
  try {
    const res = await lastProxy.request(REQUEST_NAME, [payload])
    const rtt = Date.now() - sentAt
    log(`GUEST: ✅ ROUND-TRIP OK in ${rtt}ms. response=${JSON.stringify(res)}`)
    void vscode.window.showInformationMessage(`VSLS Smoke: shareService round-trip OK (${rtt}ms) — NOT blocked.`)
  } catch (e) {
    log(`GUEST: ❌ request FAILED: ${describe(e)}`)
    void vscode.window.showErrorMessage(`VSLS Smoke: request failed — ${describe(e)}`)
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return JSON.stringify(e)
}

export function deactivate() {
  /* output channel disposed via subscriptions */
}
