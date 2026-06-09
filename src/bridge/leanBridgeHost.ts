import {
  type BridgeChannel,
  BridgeMethod,
  BridgeNotification,
  type CreateRpcSessionParams,
  type Disposable,
  type LeanClientLike,
  type SendClientNotificationParams,
  type SendClientRequestParams,
  type SubscribeParams,
} from './types.js'

const DEFAULT_KEEPALIVE_PERIOD_MS = 10_000 // host owns keepalive (see findings)

interface HostOptions {
  log?: (line: string) => void
  /** Override the keepalive period (default 10s). Mainly for tests. */
  keepAlivePeriodMs?: number
}

/**
 * Host side of the bridge. Registers request handlers on the host channel and
 * relays them to the real Lean server (`LeanClientLike`):
 *   - `createRpcSession` -> `$/lean/rpc/connect`, then owns the keepalive timer
 *   - `sendClientRequest` -> arbitrary LSP request (e.g. `$/lean/rpc/call`)
 *   - `sendClientNotification` -> arbitrary LSP notification (e.g. `$/lean/rpc/release`)
 *   - `subscribe/unsubscribeServerNotifications` -> fan out server notifications
 *     (e.g. `$/lean/fileProgress`, diagnostics) back to the guest over the channel
 *
 * Transport-agnostic: it only knows `BridgeChannel`, so it runs identically over
 * loopback, WebSocket, or Live Share.
 */
export class LeanBridgeHost {
  private readonly subscriptions: Disposable[] = []
  private readonly keepAlive = new Map<string, { uri: string; timer: NodeJS.Timeout }>()
  private readonly serverSubs = new Map<string, { count: number; disposable: Disposable }>()
  private readonly log: (line: string) => void
  private readonly keepAlivePeriodMs: number

  constructor(
    private readonly channel: BridgeChannel,
    private readonly client: LeanClientLike,
    options: HostOptions = {},
  ) {
    this.log = options.log ?? (() => {})
    this.keepAlivePeriodMs = options.keepAlivePeriodMs ?? DEFAULT_KEEPALIVE_PERIOD_MS
    this.register()
  }

  private register() {
    this.on(BridgeMethod.createRpcSession, async (p: CreateRpcSessionParams) => {
      const { sessionId } = (await this.client.sendRequest('$/lean/rpc/connect', { uri: p.uri })) as {
        sessionId: string
      }
      this.startKeepAlive(p.uri, sessionId)
      this.log(`createRpcSession(${p.uri}) -> ${sessionId}`)
      return sessionId
    })

    this.on(BridgeMethod.closeRpcSession, async (p: { sessionId: string }) => {
      this.stopKeepAlive(p.sessionId)
      return null
    })

    this.on(BridgeMethod.sendClientRequest, async (p: SendClientRequestParams) => {
      return await this.client.sendRequest(p.method, p.params)
    })

    this.on(BridgeMethod.sendClientNotification, async (p: SendClientNotificationParams) => {
      await this.client.sendNotification(p.method, p.params)
      return null
    })

    this.on(BridgeMethod.subscribeServerNotifications, async (p: SubscribeParams) => {
      this.subscribeServer(p.method)
      return null
    })
    this.on(BridgeMethod.unsubscribeServerNotifications, async (p: SubscribeParams) => {
      this.unsubscribeServer(p.method)
      return null
    })

    // Client-notification echoes are not needed for the goal-display path; accept
    // and ignore for now (the real LeanClient exposes `didChange` for these).
    this.on(BridgeMethod.subscribeClientNotifications, async () => null)
    this.on(BridgeMethod.unsubscribeClientNotifications, async () => null)

    this.on(BridgeMethod.getServerInitializeResult, async () => this.client.getInitializeResult() ?? null)

    this.on(BridgeMethod.getDiagnostics, async () => this.client.getDiagnostics())

    this.on(BridgeMethod.getFileProgress, async () => this.client.getFileProgress?.() ?? [])

    this.on(BridgeMethod.restartFile, async (p: { uri: string }) => {
      await this.client.restartFile?.(p.uri)
      return null
    })
  }

  private on(method: string, handler: (params: any) => Promise<unknown>) {
    this.subscriptions.push(this.channel.onRequest(method, handler))
  }

  private startKeepAlive(uri: string, sessionId: string) {
    this.stopKeepAlive(sessionId)
    const timer = setInterval(() => {
      void Promise.resolve(this.client.sendNotification('$/lean/rpc/keepAlive', { uri, sessionId })).catch(e =>
        this.log(`keepAlive failed for ${sessionId}: ${e}`),
      )
    }, this.keepAlivePeriodMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.keepAlive.set(sessionId, { uri, timer })
  }

  private stopKeepAlive(sessionId: string) {
    const entry = this.keepAlive.get(sessionId)
    if (entry) {
      clearInterval(entry.timer)
      this.keepAlive.delete(sessionId)
    }
  }

  private subscribeServer(method: string) {
    const existing = this.serverSubs.get(method)
    if (existing) {
      existing.count += 1
      return
    }
    const disposable = this.client.onServerNotification(method, params => {
      this.channel.notify(BridgeNotification.serverNotification, { method, params })
    })
    this.serverSubs.set(method, { count: 1, disposable })
    this.log(`subscribed to server notification '${method}'`)
  }

  private unsubscribeServer(method: string) {
    const existing = this.serverSubs.get(method)
    if (!existing) return
    existing.count -= 1
    if (existing.count <= 0) {
      existing.disposable.dispose()
      this.serverSubs.delete(method)
    }
  }

  dispose() {
    for (const { timer } of this.keepAlive.values()) clearInterval(timer)
    this.keepAlive.clear()
    for (const { disposable } of this.serverSubs.values()) disposable.dispose()
    this.serverSubs.clear()
    for (const s of this.subscriptions) s.dispose()
    this.subscriptions.length = 0
  }
}
