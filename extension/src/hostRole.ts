import * as vscode from 'vscode'
import * as vsls from 'vsls'
import { LeanBridgeHost } from '../../src/bridge/leanBridgeHost.js'
import { makeUriTranslatingHostChannel } from '../../src/bridge/uriTranslation.js'
import { startWebSocketHost, type WebSocketHost } from '../../src/bridge/webSocketChannel.js'
import { adaptLeanClient, type HostClients, type RealLeanClient } from './leanClientAdapter.js'
import { portForSession, SHARED_SERVER_NAME } from './protocol.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface LeanClientProviderLike {
  getClients(): RealLeanClient[]
  clientAdded?: (handler: (c: RealLeanClient) => void) => vscode.Disposable
}

/** Get vscode-lean4's `clientProvider` (which hands out `LeanClient`s) via its public exports. */
async function getClientProvider(log: (s: string) => void): Promise<LeanClientProviderLike | undefined> {
  const leanExt = vscode.extensions.getExtension('leanprover.lean4')
  if (!leanExt) {
    log('HOST: vscode-lean4 (leanprover.lean4) is not installed — cannot bridge the Lean server.')
    return undefined
  }
  try {
    const exports: any = await leanExt.activate()
    const features = await exports.lean4EnabledFeatures
    return features.clientProvider
  } catch (e) {
    log(`HOST: failed to obtain vscode-lean4 clientProvider: ${describe(e)}`)
    return undefined
  }
}

/** Bind the bridge port, retrying briefly to ride out a previous server still releasing it. */
async function bindWithRetry(port: number, log: (s: string) => void): Promise<WebSocketHost | undefined> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await startWebSocketHost(port, '127.0.0.1')
    } catch (e) {
      log(`HOST: bind ${port} failed (attempt ${attempt}): ${describe(e)}; retrying...`)
      await sleep(1000)
    }
  }
  return undefined
}

/**
 * Wire the host side. Because Live Share gates custom shared services, we run a
 * localhost WebSocket server, expose it to guests via `shareServer(port)`, and
 * relay each guest connection to the host's real Lean client (with vsls<->file
 * URI translation). The port is derived from the session id so the guest can
 * find it without the gated `shareService`.
 */
export async function startHostRole(api: vsls.LiveShare, log: (s: string) => void): Promise<vscode.Disposable> {
  const sessionId = api.session.id
  if (!sessionId) {
    log('HOST: no session id yet; cannot start bridge.')
    return { dispose: () => {} }
  }
  const port = portForSession(sessionId)

  const clientProvider = await getClientProvider(log)
  if (!clientProvider) return { dispose: () => {} }

  for (let i = 0; i < 40 && clientProvider.getClients().length === 0; i++) await sleep(250)
  log(`HOST: ${clientProvider.getClients().length} Lean client(s) available.`)

  const wsHost = await bindWithRetry(port, log)
  if (!wsHost) {
    log(`HOST: gave up binding bridge port ${port}. Re-host the session to retry on a new port.`)
    return { dispose: () => {} }
  }
  log(`HOST: WebSocket bridge listening on 127.0.0.1:${port}`)

  const toLocal = (s: string) => safeConvert(() => api.convertSharedUriToLocal(vscode.Uri.parse(s)).toString(), s)
  const toShared = (s: string) => safeConvert(() => api.convertLocalUriToShared(vscode.Uri.parse(s)).toString(), s)
  const hostClients: HostClients = {
    getClients: () => clientProvider.getClients(),
    onClientAdded: clientProvider.clientAdded,
  }
  const adapter = adaptLeanClient(hostClients, log)

  // Accept guest connections; one bridge per connection (supports multiple guests
  // and rejoins). Each bridge is torn down when its socket closes.
  const bridges = new Set<LeanBridgeHost>()
  let accepting = true
  let anyGuestConnected = false
  const accept = async () => {
    while (accepting) {
      let conn
      try {
        conn = await wsHost.nextConnection()
      } catch {
        break
      }
      if (!accepting) break
      anyGuestConnected = true
      log('HOST: guest connected to bridge.')
      const channel = makeUriTranslatingHostChannel(conn, { incoming: toLocal, outgoing: toShared })
      const bridge = new LeanBridgeHost(channel, adapter, { log })
      bridges.add(bridge)
      conn.onClose(() => {
        bridge.dispose()
        bridges.delete(bridge)
        log('HOST: guest disconnected from bridge.')
      })
    }
  }
  void accept()

  // Port sharing is LAZY. A same-machine guest reaches the WebSocket directly
  // over loopback — no tunnel needed, and no prompt. We only call `shareServer`
  // (which triggers Live Share's unavoidable "share this port?" confirmation)
  // when a guest has joined but hasn't connected directly within a short window,
  // i.e. they're remote and actually need the port tunnelled.
  const shareEnabled = vscode.workspace
    .getConfiguration('leanLiveShare')
    .get<boolean>('shareServerForRemoteGuests', true)
  let serverShare: vscode.Disposable | undefined
  let sharePending = false
  const maybeShareForRemoteGuest = () => {
    if (!shareEnabled || serverShare || sharePending) return
    sharePending = true
    setTimeout(async () => {
      sharePending = false
      if (!accepting || serverShare || anyGuestConnected) return // local guest reached us directly
      try {
        serverShare = await api.shareServer({ port, displayName: SHARED_SERVER_NAME })
        log(`HOST: a guest hasn't connected directly; shared port ${port} (remote guest tunnel).`)
      } catch (e) {
        log(`HOST: shareServer failed (${describe(e)}).`)
      }
    }, 6000)
  }
  const hasGuestPeer = () => api.peers.some(p => p.role === vsls.Role.Guest)
  if (hasGuestPeer()) maybeShareForRemoteGuest()
  const peersSub = api.onDidChangePeers(e => {
    if (e.added.some(p => p.role === vsls.Role.Guest)) maybeShareForRemoteGuest()
  })

  log('HOST: bridge is live; guests can now open the Lean infoview.')

  return {
    dispose: () => {
      accepting = false
      peersSub.dispose()
      for (const b of bridges) b.dispose()
      bridges.clear()
      serverShare?.dispose()
      void wsHost.close()
      log('HOST: bridge disposed.')
    },
  }
}

function safeConvert(fn: () => string, fallback: string): string {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
