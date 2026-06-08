import type { BridgeChannel, Disposable, NotifyHandler, RequestHandler } from './types.js'

/**
 * Two `BridgeChannel`s wired directly to each other in-process. A request on
 * one end is dispatched to the other end's registered request handler; a notify
 * fans out to the other end's notify handlers.
 *
 * Params and results are JSON round-tripped, so the loopback faithfully mimics
 * the serialization boundary of a real transport (catching e.g. `undefined`
 * vs. `null` and non-serializable values) without any infrastructure.
 */
class LoopbackChannel implements BridgeChannel {
  peer!: LoopbackChannel
  private requestHandlers = new Map<string, RequestHandler>()
  private notifyHandlers = new Map<string, Set<NotifyHandler>>()
  private disposed = false

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.disposed) throw new Error('channel disposed')
    const handler = this.peer.requestHandlers.get(method)
    if (!handler) throw new Error(`no request handler for '${method}'`)
    const result = await handler(clone(params))
    return clone(result)
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return
    const handlers = this.peer.notifyHandlers.get(method)
    if (!handlers) return
    const cloned = clone(params)
    for (const h of [...handlers]) queueMicrotask(() => h(cloned))
  }

  onRequest(method: string, handler: RequestHandler): Disposable {
    if (this.requestHandlers.has(method)) {
      throw new Error(`request handler already registered for '${method}'`)
    }
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
    this.disposed = true
    this.requestHandlers.clear()
    this.notifyHandlers.clear()
  }
}

/** Round-trip through JSON to mimic the serialization boundary of a real wire. */
function clone<T>(value: T): T {
  if (value === undefined) return undefined as T
  return JSON.parse(JSON.stringify(value)) as T
}

/** Create a linked pair of in-process channels: `[a, b]`. */
export function createLoopbackPair(): [BridgeChannel, BridgeChannel] {
  const a = new LoopbackChannel()
  const b = new LoopbackChannel()
  a.peer = b
  b.peer = a
  return [a, b]
}
