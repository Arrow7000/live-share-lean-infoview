import { AddressInfo, WebSocket, WebSocketServer } from 'ws'
import type { BridgeChannel, Disposable, NotifyHandler, RequestHandler } from './types.js'

/**
 * A `BridgeChannel` over a single WebSocket. Symmetric: both ends can request,
 * notify, and register handlers. Lets a *separate* process play "guest" with no
 * Live Share at all, and doubles as a production transport via Live Share's
 * `shareServer(port)` tunnel (which forwards a localhost port to guests).
 */

type Envelope =
  | { t: 'req'; id: number; method: string; params: unknown }
  | { t: 'res'; id: number; result: unknown }
  | { t: 'err'; id: number; error: { message: string } }
  | { t: 'not'; method: string; params: unknown }

export class WebSocketChannel implements BridgeChannel {
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly notifyHandlers = new Map<string, Set<NotifyHandler>>()

  private readonly closeHandlers = new Set<() => void>()

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer | string) => void this.onMessage(data.toString()))
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('socket closed'))
      this.pending.clear()
      for (const h of [...this.closeHandlers]) h()
    })
  }

  /** Register a handler fired when the underlying socket closes. */
  onClose(handler: () => void): Disposable {
    this.closeHandlers.add(handler)
    return { dispose: () => this.closeHandlers.delete(handler) }
  }

  private async onMessage(raw: string) {
    let msg: Envelope
    try {
      msg = JSON.parse(raw) as Envelope
    } catch {
      return
    }
    if (msg.t === 'req') {
      const handler = this.requestHandlers.get(msg.method)
      if (!handler) {
        this.send({ t: 'err', id: msg.id, error: { message: `no request handler for '${msg.method}'` } })
        return
      }
      try {
        const result = await handler(msg.params)
        this.send({ t: 'res', id: msg.id, result: result ?? null })
      } catch (e) {
        this.send({ t: 'err', id: msg.id, error: { message: e instanceof Error ? e.message : String(e) } })
      }
    } else if (msg.t === 'res') {
      this.pending.get(msg.id)?.resolve(msg.result)
      this.pending.delete(msg.id)
    } else if (msg.t === 'err') {
      this.pending.get(msg.id)?.reject(new Error(msg.error.message))
      this.pending.delete(msg.id)
    } else if (msg.t === 'not') {
      const handlers = this.notifyHandlers.get(msg.method)
      if (handlers) for (const h of [...handlers]) h(msg.params)
    }
  }

  private send(env: Envelope) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(env))
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ t: 'req', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ t: 'not', method, params })
  }

  onRequest(method: string, handler: RequestHandler): Disposable {
    if (this.requestHandlers.has(method)) throw new Error(`request handler already registered for '${method}'`)
    this.requestHandlers.set(method, handler)
    return { dispose: () => this.requestHandlers.delete(method) }
  }

  onNotify(method: string, handler: NotifyHandler): Disposable {
    let set = this.notifyHandlers.get(method)
    if (!set) {
      set = new Set()
      this.notifyHandlers.set(method, set)
    }
    set.add(handler)
    return { dispose: () => set!.delete(handler) }
  }

  dispose(): void {
    this.requestHandlers.clear()
    this.notifyHandlers.clear()
    for (const { reject } of this.pending.values()) reject(new Error('channel disposed'))
    this.pending.clear()
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close()
  }
}

export interface WebSocketHost {
  /** Actual port the server is listening on (useful when starting on port 0). */
  port: number
  server: WebSocketServer
  /** Resolves with a channel for the next guest connection. */
  nextConnection(): Promise<WebSocketChannel>
  close(): Promise<void>
}

/** Start a WebSocket server on `host:port` (port 0 = ephemeral). */
export function startWebSocketHost(port = 0, host = '127.0.0.1'): Promise<WebSocketHost> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port, host })
    const waiting: Array<(c: WebSocketChannel) => void> = []
    const queued: WebSocketChannel[] = []

    server.on('connection', socket => {
      const channel = new WebSocketChannel(socket)
      const next = waiting.shift()
      if (next) next(channel)
      else queued.push(channel)
    })
    server.on('error', reject)
    server.on('listening', () => {
      const addr = server.address() as AddressInfo
      resolve({
        port: addr.port,
        server,
        nextConnection: () =>
          new Promise<WebSocketChannel>(res => {
            const c = queued.shift()
            if (c) res(c)
            else waiting.push(res)
          }),
        close: () =>
          new Promise<void>(res => {
            for (const c of queued) c.dispose()
            server.close(() => res())
          }),
      })
    })
  })
}

/** Connect a guest channel to a WebSocket host. */
export function connectWebSocketGuest(url: string): Promise<WebSocketChannel> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.on('open', () => resolve(new WebSocketChannel(socket)))
    socket.on('error', reject)
  })
}
