/** Name of the Live Share shared service. No package prefix: host and guest run
 * the same extension, so they reference the service by its bare name.
 *
 * NOTE: `shareService`/`getSharedService` are gated by Live Share to an
 * allowlist and return `null` for third-party extensions (confirmed against
 * vscode-lean4#390). We therefore transport over `shareServer(port)` +
 * WebSocket instead; this constant is retained only for reference. */
export const SERVICE_NAME = 'leanInfoviewBridge'

/** User-visible name for the shared server (shown in Live Share's UI). */
export const SHARED_SERVER_NAME = 'Lean Infoview Bridge'

/**
 * Derive a stable TCP port from the Live Share session id, so the host and the
 * guest agree on a port WITHOUT needing the gated `shareService` to exchange it.
 * Both peers see the same `session.id`, so both compute the same port.
 */
export function portForSession(sessionId: string): number {
  let h = 2166136261 >>> 0 // FNV-1a
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  // Range 30000–49999 (well above privileged/common ports, below ephemeral default).
  return 30000 + (h % 20000)
}
