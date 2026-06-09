import * as vscode from 'vscode'
import type {
  DiagnosticsForUri,
  Disposable,
  FileProgressForUri,
  LeanClientLike,
  ServerInitializeResultLike,
} from '../../src/bridge/types.js'
import { extractUri, pickByFolder } from '../../src/bridge/uriRouting.js'

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
  /** The project root this client manages (an ExtUri; we read `fsPath`/`toString`). */
  folderUri?: { fsPath?: string; toString(): string }
  /** Saved current file-progress per file (keyed by an ExtUri). */
  progress?: Map<{ toString(): string }, unknown[]>
}

/** A live view of the host's Lean clients (one per project root). */
export interface HostClients {
  getClients(): RealLeanClient[]
  onClientAdded?: (handler: (c: RealLeanClient) => void) => Disposable
}

function folderPathOf(c: RealLeanClient): string {
  return c.folderUri?.fsPath ?? c.folderUri?.toString() ?? ''
}

function fsPathOf(uri: string): string | undefined {
  try {
    return vscode.Uri.parse(uri).fsPath
  } catch {
    return undefined
  }
}

/**
 * Adapt the host's vscode-lean4 client(s) to the bridge's `LeanClientLike`,
 * routing each request to the project whose root contains the request's URI
 * (so multiple open Lean projects work), and fanning notifications/diagnostics
 * out across all clients.
 */
export function adaptLeanClient(clients: HostClients, log: (s: string) => void): LeanClientLike {
  const clientFor = (params: unknown): RealLeanClient | undefined => {
    const list = clients.getClients()
    const uri = extractUri(params)
    return pickByFolder(list, folderPathOf, uri ? fsPathOf(uri) : undefined)
  }

  return {
    async sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
      const c = clientFor(params)
      if (!c) throw new Error('no Lean client available on the host yet')
      return (await c.sendRequest(method, params)) as T
    },
    async sendNotification(method: string, params: unknown): Promise<void> {
      const c = clientFor(params)
      if (!c) {
        log(`sendNotification('${method}'): no matching Lean client; dropped`)
        return
      }
      await c.sendNotification(method, params)
    },
    onServerNotification(method: string, handler: (params: unknown) => void): Disposable {
      // Subscribe across all current clients, and any that appear later.
      const disposables: Disposable[] = []
      const subscribe = (c: RealLeanClient) => {
        if (method === 'textDocument/publishDiagnostics') {
          disposables.push(c.diagnostics((params: unknown) => handler(params)))
        } else {
          disposables.push(
            c.customNotification(({ method: m, params }) => {
              if (m === method) handler(params)
            }),
          )
        }
      }
      for (const c of clients.getClients()) subscribe(c)
      if (clients.onClientAdded) disposables.push(clients.onClientAdded(subscribe))
      return { dispose: () => disposables.forEach(d => d.dispose()) }
    },
    getInitializeResult(): ServerInitializeResultLike | undefined {
      for (const c of clients.getClients()) {
        const capabilities = c.serverCapabilities()
        if (!capabilities) continue
        const anyClient = c as unknown as {
          client?: { initializeResult?: { serverInfo?: { name?: string; version?: string } } }
        }
        const serverInfo = anyClient.client?.initializeResult?.serverInfo ?? { name: 'Lean 4 Server', version: '0.0.0' }
        return { serverInfo, capabilities }
      }
      return undefined
    },
    getDiagnostics(): DiagnosticsForUri[] {
      // Preferred source: lean4's own accumulated diagnostics store (across all
      // clients). These are the raw LSP-shaped params and crucially include the
      // *silent* diagnostics (`GoalsAccomplished`) that lean4 filters OUT of VS
      // Code's collection (diagnostics.ts: `.filter(d => !d.isSilent)`), so
      // `vscode.languages.getDiagnostics()` would never include the checkmark.
      const out: DiagnosticsForUri[] = []
      let usedRawStore = false
      for (const c of clients.getClients()) {
        const diags = (c as unknown as { diagnosticCollection?: { diags?: Map<string, DiagnosticsForUri> } })
          .diagnosticCollection?.diags
        if (diags && typeof diags.values === 'function') {
          usedRawStore = true
          for (const p of diags.values()) out.push({ uri: p.uri, diagnostics: p.diagnostics ?? [] })
        }
      }
      if (usedRawStore) return out

      // Fallback (only non-silent diagnostics): VS Code's collection.
      log('getDiagnostics: lean4 diagnosticCollection.diags unavailable; falling back (no silent diagnostics)')
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
    getFileProgress(): FileProgressForUri[] {
      const out: FileProgressForUri[] = []
      for (const c of clients.getClients()) {
        const progress = c.progress
        if (!progress || typeof progress.entries !== 'function') continue
        for (const [extUri, processing] of progress.entries()) {
          out.push({ uri: extUri.toString(), processing: processing ?? [] })
        }
      }
      return out
    },
    async restartFile(uri: string): Promise<void> {
      // vscode-lean4's restart only acts on the active editor (the `lean4.restartFile`
      // command), and its provider API needs an ExtUri we can't construct. So reveal
      // the file (which makes it the active Lean editor on the host) and run the command.
      try {
        await vscode.window.showTextDocument(vscode.Uri.parse(uri), { preserveFocus: false })
        await vscode.commands.executeCommand('lean4.restartFile')
      } catch (e) {
        log(`restartFile failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}
