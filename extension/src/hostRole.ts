import * as vscode from 'vscode'
import type * as vsls from 'vsls'
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

  // Avoid Live Share's "share this port?" prompt: that prompt comes from Live
  // Share auto-detecting the listening port. Disabling auto-detection lets our
  // *explicit* shareServer() call go through silently.
  await suppressPortSharePrompt(log)

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
  const hostClients: HostClients = {
    getClients: () => clientProvider.getClients(),
    onClientAdded: clientProvider.clientAdded,
  }
  const adapter = adaptLeanClient(hostClients, log)

  // Accept guest connections; one bridge per connection (supports multiple guests
  // and rejoins). Each bridge is torn down when its socket closes.
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
      conn.onClose(() => {
        bridge.dispose()
        bridges.delete(bridge)
        log('HOST: guest disconnected from bridge.')
      })
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

/**
 * Disable Live Share's automatic port detection/prompt so our explicit
 * `shareServer()` doesn't trigger a "share this port?" notification. Honors a
 * user who has already chosen a value, and respects our own opt-out setting.
 */
async function suppressPortSharePrompt(log: (s: string) => void): Promise<void> {
  if (!vscode.workspace.getConfiguration('leanLiveShare').get<boolean>('suppressPortSharePrompt', true)) {
    return
  }
  const cfg = vscode.workspace.getConfiguration('liveshare')
  const current = cfg.inspect<boolean>('autoShareServers')
  const explicitlySet = current?.globalValue ?? current?.workspaceValue
  if (explicitlySet === false) return // already disabled
  try {
    await cfg.update('autoShareServers', false, vscode.ConfigurationTarget.Global)
    log(
      'HOST: set liveshare.autoShareServers=false to avoid the port-share prompt ' +
        '(revert in settings, or set leanLiveShare.suppressPortSharePrompt=false).',
    )
  } catch (e) {
    log(`HOST: could not set liveshare.autoShareServers: ${describe(e)}`)
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
