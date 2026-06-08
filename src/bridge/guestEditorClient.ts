import {
  type BridgeChannel,
  BridgeMethod,
  BridgeNotification,
  type Disposable,
  type NotifyHandler,
  type ServerNotificationPayload,
} from './types.js'

/**
 * Guest side of the bridge. Exposes the subset of the infoview's `EditorApi`
 * that routes to the host's Lean server over a `BridgeChannel`, plus local
 * dispatch of forwarded server notifications.
 *
 * In M3 this is what the guest webview's `EditorApi` shim delegates to (across
 * the extra webview<->extension-host postMessage hop). In M2 it is the "fake
 * guest" used by the loopback/WebSocket integration tests.
 */
export class GuestEditorClient {
  private readonly serverNotifyHandlers = new Map<string, Set<NotifyHandler>>()
  private readonly subscriptions: Disposable[] = []

  constructor(private readonly channel: BridgeChannel) {
    this.subscriptions.push(
      this.channel.onNotify(BridgeNotification.serverNotification, (payload: unknown) => {
        const { method, params } = payload as ServerNotificationPayload
        const handlers = this.serverNotifyHandlers.get(method)
        if (handlers) for (const h of [...handlers]) h(params)
      }),
    )
  }

  createRpcSession(uri: string): Promise<string> {
    return this.channel.request(BridgeMethod.createRpcSession, { uri }) as Promise<string>
  }

  async closeRpcSession(sessionId: string): Promise<void> {
    await this.channel.request(BridgeMethod.closeRpcSession, { sessionId })
  }

  sendClientRequest(uri: string, method: string, params: unknown): Promise<unknown> {
    return this.channel.request(BridgeMethod.sendClientRequest, { uri, method, params })
  }

  async sendClientNotification(uri: string, method: string, params: unknown): Promise<void> {
    await this.channel.request(BridgeMethod.sendClientNotification, { uri, method, params })
  }

  async subscribeServerNotifications(method: string): Promise<void> {
    await this.channel.request(BridgeMethod.subscribeServerNotifications, { method })
  }

  async unsubscribeServerNotifications(method: string): Promise<void> {
    await this.channel.request(BridgeMethod.unsubscribeServerNotifications, { method })
  }

  /** Register a local handler for a forwarded server notification. */
  onServerNotification(method: string, handler: NotifyHandler): Disposable {
    let set = this.serverNotifyHandlers.get(method)
    if (!set) {
      set = new Set()
      this.serverNotifyHandlers.set(method, set)
    }
    set.add(handler)
    return { dispose: () => set!.delete(handler) }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.subscriptions.length = 0
    this.serverNotifyHandlers.clear()
  }
}
