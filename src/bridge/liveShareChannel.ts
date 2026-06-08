/**
 * `BridgeChannel` implementations over Live Share's generic messaging API
 * (`shareService` / `getSharedService`). This is the only transport that needs
 * a real Live Share session; it is a thin adapter so almost nothing depends on
 * it. The vsls types are declared locally (structurally compatible) so `src/`
 * stays free of a `vsls` dependency.
 *
 * Role asymmetry (matches Live Share): the host can only answer requests and
 * push notifications (`onRequest`/`onNotify`/`notify`); the guest can only send
 * requests and receive notifications (`request`/`notify`/`onNotify`). The host
 * bridge uses only the former set; the guest client uses only the latter, so
 * the unused directions throw to surface accidental misuse.
 */

import type { BridgeChannel, Disposable, NotifyHandler, RequestHandler } from './types.js'

export interface VslsSharedService {
  onRequest(name: string, handler: (args: any[]) => any): void
  onNotify(name: string, handler: (args: object) => void): void
  notify(name: string, args: object): void
}

export interface VslsSharedServiceProxy {
  request(name: string, args: any[], cancellation?: unknown): Promise<any>
  onNotify(name: string, handler: (args: object) => void): void
  notify(name: string, args: object): void
}

// Notifications must carry an object payload through vsls; wrap/unwrap so any
// JSON value (arrays, primitives) can cross.
interface NotifyEnvelope {
  payload: unknown
}

const noopDisposable: Disposable = { dispose: () => {} }

/** Host-side channel backed by a Live Share `SharedService`. */
export function createHostChannel(service: VslsSharedService): BridgeChannel {
  return {
    request(): Promise<unknown> {
      throw new Error('LiveShare host channel cannot issue requests to guests')
    },
    notify(method: string, params: unknown): void {
      service.notify(method, { payload: params } satisfies NotifyEnvelope)
    },
    onRequest(method: string, handler: RequestHandler): Disposable {
      service.onRequest(method, (args: any[]) => handler(args?.[0]))
      return noopDisposable
    },
    onNotify(method: string, handler: NotifyHandler): Disposable {
      service.onNotify(method, (args: object) => handler((args as NotifyEnvelope).payload))
      return noopDisposable
    },
    dispose() {},
  }
}

/** Guest-side channel backed by a Live Share `SharedServiceProxy`. */
export function createGuestChannel(proxy: VslsSharedServiceProxy): BridgeChannel {
  return {
    request(method: string, params: unknown): Promise<unknown> {
      return proxy.request(method, [params])
    },
    notify(method: string, params: unknown): void {
      proxy.notify(method, { payload: params } satisfies NotifyEnvelope)
    },
    onRequest(): Disposable {
      throw new Error('LiveShare guest channel cannot answer requests')
    },
    onNotify(method: string, handler: NotifyHandler): Disposable {
      proxy.onNotify(method, (args: object) => handler((args as NotifyEnvelope).payload))
      return noopDisposable
    },
    dispose() {},
  }
}
