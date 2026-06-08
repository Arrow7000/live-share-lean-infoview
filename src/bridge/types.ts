/**
 * The transport-agnostic seam of the project.
 *
 * Everything in the bridge (host forwarding, guest editor client, keepalive,
 * URI translation) is written against `BridgeChannel`, never against a concrete
 * transport. Three implementations exist:
 *   - LoopbackChannel  (in-process, for unit/integration tests)
 *   - WebSocketChannel (separate process / localhost, also prod via shareServer)
 *   - LiveShareChannel (thin shareService adapter — built last)
 */

export interface Disposable {
  dispose(): void
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown
export type NotifyHandler = (params: unknown) => void

/**
 * A bidirectional JSON-RPC-ish channel between two endpoints.
 *
 * Note the asymmetry of the real transports: a Live Share host can only
 * `onRequest`/`onNotify`/`notify` (it answers and pushes), while a guest can
 * only `request`/`notify`/`onNotify` (it asks and listens). Loopback/WebSocket
 * implement all four in both directions; the LiveShare adapter implements only
 * the directions valid for its role and treats the others as no-ops. The host
 * bridge uses only {onRequest, onNotify, notify}; the guest uses only
 * {request, notify, onNotify}. Params/results must be JSON-serializable.
 */
export interface BridgeChannel {
  /** Send a request and await a response (guest -> host). */
  request(method: string, params: unknown): Promise<unknown>
  /** Fire-and-forget notification. */
  notify(method: string, params: unknown): void
  /** Register a handler for incoming requests (host side). */
  onRequest(method: string, handler: RequestHandler): Disposable
  /** Register a handler for incoming notifications. */
  onNotify(method: string, handler: NotifyHandler): Disposable
  dispose(): void
}

/**
 * Minimal subset of vscode-lean4's `LeanClient` that the host bridge needs.
 * Both the real `LeanClient` (via the extension's exports) and our headless
 * `LeanServerConnection` satisfy this, so the bridge is testable against a real
 * Lean server without VS Code.
 */
export interface LeanClientLike {
  sendRequest<T = unknown>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): void | Promise<void>
  onServerNotification(method: string, handler: (params: unknown) => void): Disposable
}

/** Bridge request methods — a 1:1 image of the infoview's `EditorApi`. */
export const BridgeMethod = {
  createRpcSession: 'editor/createRpcSession', // { uri } -> sessionId
  closeRpcSession: 'editor/closeRpcSession', // { sessionId }
  sendClientRequest: 'editor/sendClientRequest', // { uri, method, params } -> any
  sendClientNotification: 'editor/sendClientNotification', // { uri, method, params }
  subscribeServerNotifications: 'editor/subscribeServerNotifications', // { method }
  unsubscribeServerNotifications: 'editor/unsubscribeServerNotifications', // { method }
  subscribeClientNotifications: 'editor/subscribeClientNotifications', // { method }
  unsubscribeClientNotifications: 'editor/unsubscribeClientNotifications', // { method }
} as const

/** Bridge notifications (host -> guest). */
export const BridgeNotification = {
  /** A subscribed server->client notification, e.g. `$/lean/fileProgress`. */
  serverNotification: 'server/notification', // { method, params }
  /** A subscribed client->server notification echo. */
  clientNotification: 'client/notification', // { method, params }
  serverRestarted: 'server/restarted',
  serverStopped: 'server/stopped',
} as const

export interface SendClientRequestParams {
  uri: string
  method: string
  params: unknown
}
export interface SendClientNotificationParams {
  uri: string
  method: string
  params: unknown
}
export interface CreateRpcSessionParams {
  uri: string
}
export interface SubscribeParams {
  method: string
}
export interface ServerNotificationPayload {
  method: string
  params: unknown
}
