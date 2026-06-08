/**
 * URI translation across the host/guest boundary.
 *
 * Guests address files with `vsls:` URIs; the host's Lean server only knows
 * `file:` URIs. Every URI crossing the bridge must be remapped both ways:
 *   - request params arriving at the host: vsls: -> file:  (incoming)
 *   - results and notifications leaving the host: file: -> vsls:  (outgoing)
 *
 * The actual scheme conversion is supplied by the caller (the extension uses
 * Live Share's `convertSharedUriToLocal` / `convertLocalUriToShared`), so this
 * module is pure and unit-testable.
 */

import type { BridgeChannel, Disposable, NotifyHandler, RequestHandler } from './types.js'

export type UriMapper = (value: string) => string

/** Deep-clone `value`, rewriting every string that looks like a URI via `map`. */
export function remapUris(value: unknown, map: UriMapper, looksLikeUri: (s: string) => boolean): unknown {
  if (typeof value === 'string') return looksLikeUri(value) ? map(value) : value
  if (Array.isArray(value)) return value.map(v => remapUris(v, map, looksLikeUri))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = remapUris(v, map, looksLikeUri)
    return out
  }
  return value
}

export interface HostUriTranslation {
  /** Convert an incoming guest URI (`vsls:`) to a host URI (`file:`). */
  incoming: UriMapper
  /** Convert an outgoing host URI (`file:`) to a guest URI (`vsls:`). */
  outgoing: UriMapper
}

const startsWithScheme = (scheme: string) => (s: string) => s.startsWith(`${scheme}:`)

/**
 * Wrap a host-side `BridgeChannel` so URIs are translated automatically:
 * request params are mapped guest->host before the handler runs, and handler
 * results plus outgoing notifications are mapped host->guest.
 */
export function makeUriTranslatingHostChannel(
  inner: BridgeChannel,
  translation: HostUriTranslation,
  schemes: { guest: string; host: string } = { guest: 'vsls', host: 'file' },
): BridgeChannel {
  const isGuestUri = startsWithScheme(schemes.guest)
  const isHostUri = startsWithScheme(schemes.host)
  return {
    request(method, params) {
      return inner.request(method, params)
    },
    notify(method, params) {
      inner.notify(method, remapUris(params, translation.outgoing, isHostUri))
    },
    onRequest(method: string, handler: RequestHandler): Disposable {
      return inner.onRequest(method, async (params: unknown) => {
        const local = remapUris(params, translation.incoming, isGuestUri)
        const result = await handler(local)
        return remapUris(result, translation.outgoing, isHostUri)
      })
    },
    onNotify(method: string, handler: NotifyHandler): Disposable {
      return inner.onNotify(method, handler)
    },
    dispose() {
      inner.dispose()
    },
  }
}
