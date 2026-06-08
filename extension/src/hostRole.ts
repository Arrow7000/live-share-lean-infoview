import * as vscode from 'vscode'
import type * as vsls from 'vsls'
import { LeanBridgeHost } from '../../src/bridge/leanBridgeHost.js'
import { makeUriTranslatingHostChannel } from '../../src/bridge/uriTranslation.js'
import { startWebSocketHost, type WebSocketHost } from '../../src/bridge/webSocketChannel.js'
import { adaptLeanClient, type RealLeanClient } from './leanClientAdapter.js'
import { portForSession, SHARED_SERVER_NAME } from './protocol.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Get vscode-lean4's `clientProvider` (which hands out `LeanClient`s) via its public exports. */
async function getClientProvider(
  log: (s: string) => void,
): Promise<{ getClients(): RealLeanClient[] } | undefined> {
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

  let wsHost: WebSocketHost
  try {
    wsHost = await startWebSocketHost(port, '127.0.0.1')
    log(`HOST: WebSocket bridge listening on 127.0.0.1:${port}`)
  } catch (e) {
    log(`HOST: failed to bind bridge port ${port}: ${describe(e)}`)
    return { dispose: () => {} }
  }

  // Expose the port to remote guests (no-op/redundant for same-machine guests,
  // which reach localhost:port directly). shareServer has no allowlist gate.
  let serverShare: vscode.Disposable | undefined
  try {
    serverShare = await api.shareServer({ port, displayName: SHARED_SERVER_NAME })
    log(`HOST: shared server port ${port} to guests.`)
  } catch (e) {
    log(`HOST: shareServer failed (${describe(e)}); same-machine guests will still work.`)
  }

  const toLocal = (s: string) => safeConvert(() => api.convertSharedUriToLocal(vscode.Uri.parse(s)).toString(), s)
  const toShared = (s: string) => safeConvert(() => api.convertLocalUriToShared(vscode.Uri.parse(s)).toString(), s)
  const adapter = adaptLeanClient(() => clientProvider.getClients()[0], log)

  // Accept guest connections; one bridge per connection (supports multiple guests).
  const bridges = new Set<LeanBridgeHost>()
  let accepting = true
  const accept = async () => {
    while (accepting) {
      let conn
      try {
        conn = await wsHost.nextConnection()
      } catch {
        break
      }
      if (!accepting) break
      log('HOST: guest connected to bridge.')
      const channel = makeUriTranslatingHostChannel(conn, { incoming: toLocal, outgoing: toShared })
      const bridge = new LeanBridgeHost(channel, adapter, { log })
      bridges.add(bridge)
    }
  }
  void accept()
  log('HOST: bridge is live; guests can now open the Lean infoview.')

  return {
    dispose: () => {
      accepting = false
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
