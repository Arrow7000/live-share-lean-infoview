/**
 * Pure helpers for routing a bridge request to the right Lean client when the
 * host has several Lean projects open. Kept free of `vscode` so they're unit-tested.
 */

/** Pull the document URI out of a bridge request's params (rpc connect/call/release/keepAlive). */
export function extractUri(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const p = params as { uri?: unknown; textDocument?: { uri?: unknown } }
  if (typeof p.uri === 'string') return p.uri
  if (p.textDocument && typeof p.textDocument.uri === 'string') return p.textDocument.uri
  return undefined
}

function isPathPrefix(folder: string, target: string): boolean {
  const norm = folder.endsWith('/') ? folder.slice(0, -1) : folder
  return target === norm || target.startsWith(norm + '/')
}

/**
 * Pick the item whose folder path is the longest prefix of `targetPath`
 * (the innermost project wins). Falls back to the first item when there's no
 * target or no match — preserving single-project behaviour.
 */
export function pickByFolder<T>(
  items: readonly T[],
  folderPathOf: (t: T) => string,
  targetPath: string | undefined,
): T | undefined {
  if (items.length === 0) return undefined
  if (!targetPath) return items[0]
  let best: T | undefined
  let bestLen = -1
  for (const it of items) {
    const folder = folderPathOf(it)
    if (isPathPrefix(folder, targetPath) && folder.length > bestLen) {
      best = it
      bestLen = folder.length
    }
  }
  return best ?? items[0]
}
