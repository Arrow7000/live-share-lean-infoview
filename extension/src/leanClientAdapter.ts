import * as vscode from 'vscode'
import type { DiagnosticsForUri, Disposable, LeanClientLike, ServerInitializeResultLike } from '../../src/bridge/types.js'

function lspRange(r: vscode.Range) {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  }
}

/**
 * The slice of vscode-lean4's `LeanClient` we rely on (typed loosely since we
 * can't import the extension's private types). Verified against
 * reference/vscode-lean4/src/leanclient.ts.
 */
export interface RealLeanClient {
  sendRequest(method: string, params: unknown, token?: unknown): Promise<unknown>
  sendNotification(method: string, params: unknown): Promise<void> | undefined
  /** Fires for any custom (non-standard) notification, incl. `$/lean/fileProgress`. */
  customNotification: vscode.Event<{ method: string; params: unknown }>
  /** Fires for `textDocument/publishDiagnostics` (Lean's enriched form). */
  diagnostics: vscode.Event<unknown>
  serverCapabilities(): unknown
}

/**
 * Adapt a vscode-lean4 `LeanClient` (resolved lazily, since it may appear/restart)
 * to the bridge's `LeanClientLike`.
 */
export function adaptLeanClient(resolve: () => RealLeanClient | undefined, log: (s: string) => void): LeanClientLike {
  const require = (): RealLeanClient => {
    const c = resolve()
    if (!c) throw new Error('no Lean client available on the host yet')
    return c
  }
  return {
    async sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
      return (await require().sendRequest(method, params)) as T
    },
    async sendNotification(method: string, params: unknown): Promise<void> {
      await require().sendNotification(method, params)
    },
    onServerNotification(method: string, handler: (params: unknown) => void): Disposable {
      const client = resolve()
      if (!client) {
        log(`onServerNotification('${method}'): no client yet; notification will not be forwarded`)
        return { dispose: () => {} }
      }
      if (method === 'textDocument/publishDiagnostics') {
        return client.diagnostics((params: unknown) => handler(params))
      }
      return client.customNotification(({ method: m, params }) => {
        if (m === method) handler(params)
      })
    },
    getInitializeResult(): ServerInitializeResultLike | undefined {
      const client = resolve()
      if (!client) return undefined
      const capabilities = client.serverCapabilities()
      // serverInfo isn't on LeanClient's public surface; dig into the underlying
      // LanguageClient, falling back to a plausible default so the infoview starts.
      const anyClient = client as unknown as { client?: { initializeResult?: { serverInfo?: { name?: string; version?: string } } } }
      const serverInfo = anyClient.client?.initializeResult?.serverInfo ?? { name: 'Lean 4 Server', version: '0.0.0' }
      if (!capabilities) return undefined
      return { serverInfo, capabilities }
    },
    getDiagnostics(): DiagnosticsForUri[] {
      const client = resolve()
      // Preferred source: lean4's own accumulated diagnostics store. These are the
      // raw LSP-shaped params and crucially include the *silent* diagnostics
      // (`GoalsAccomplished`) that lean4 filters OUT of VS Code's collection
      // (see vscode-lean4 diagnostics.ts: it `.filter(d => !d.isSilent)` before
      // setting vsCodeCollection). So `vscode.languages.getDiagnostics()` would
      // never include the checkmark tag.
      const collection = (client as unknown as { diagnosticCollection?: { diags?: Map<string, DiagnosticsForUri> } })
        ?.diagnosticCollection
      const diags = collection?.diags
      if (diags && typeof diags.values === 'function') {
        return [...diags.values()].map(p => ({ uri: p.uri, diagnostics: p.diagnostics ?? [] }))
      }

      // Fallback (only non-silent diagnostics): VS Code's collection. lean4 keeps
      // leanTags on the Diagnostic objects, but silent ones (the checkmark) are absent.
      log('getDiagnostics: lean4 diagnosticCollection.diags unavailable; falling back (no silent diagnostics)')
      const out: DiagnosticsForUri[] = []
      for (const [u, ds] of vscode.languages.getDiagnostics()) {
        if (!u.path.endsWith('.lean')) continue
        out.push({
          uri: u.toString(),
          diagnostics: ds.map(d => {
            const ext = d as vscode.Diagnostic & { leanTags?: number[]; isSilent?: boolean; fullRange?: vscode.Range }
            return {
              range: lspRange(d.range),
              fullRange: ext.fullRange ? lspRange(ext.fullRange) : undefined,
              message: d.message,
              severity: (d.severity ?? 0) + 1, // VS Code is 0-based; LSP is 1-based.
              leanTags: ext.leanTags,
              isSilent: ext.isSilent,
            }
          }),
        })
      }
      return out
    },
  }
}
