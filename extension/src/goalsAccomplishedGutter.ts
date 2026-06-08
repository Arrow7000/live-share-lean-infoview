import * as vscode from 'vscode'

/** LeanTag.GoalsAccomplished (from vscode-lean4's lspTypes). */
const GOALS_ACCOMPLISHED = 2

interface LeanDiagnosticLike {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  leanTags?: number[]
}

interface PublishDiagnosticsLike {
  uri: string
  diagnostics?: LeanDiagnosticLike[]
}

/**
 * Renders the blue "goals accomplished" double-checkmark in the gutter on the
 * guest, from Lean diagnostics tagged `GoalsAccomplished` that the host forwards
 * over the bridge. Mirrors vscode-lean4's gutter decoration (taskgutter.ts),
 * simplified to a per-line icon (no multi-line passthrough connectors yet).
 */
export class GoalsAccomplishedGutter {
  private readonly decoration: vscode.TextEditorDecorationType
  private readonly rangesByUri = new Map<string, vscode.Range[]>()
  private readonly subs: vscode.Disposable[] = []

  constructor(extensionUri: vscode.Uri) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      light: {
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'assets', 'goals-accomplished-light.svg'),
        gutterIconSize: 'contain',
      },
      dark: {
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'assets', 'goals-accomplished-dark.svg'),
        gutterIconSize: 'contain',
      },
    })
    // Re-apply when editors become visible (e.g. the guest opens the shared file).
    this.subs.push(vscode.window.onDidChangeVisibleTextEditors(() => this.apply()))
  }

  /** Update accomplished ranges for a URI from a forwarded publishDiagnostics payload. */
  update(params: PublishDiagnosticsLike): void {
    const ranges: vscode.Range[] = []
    for (const d of params.diagnostics ?? []) {
      if (d.leanTags?.includes(GOALS_ACCOMPLISHED)) {
        const line = d.range.start.line
        ranges.push(new vscode.Range(line, 0, line, 0))
      }
    }
    if (ranges.length === 0) this.rangesByUri.delete(params.uri)
    else this.rangesByUri.set(params.uri, ranges)
    this.apply()
  }

  private apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = this.rangesByUri.get(editor.document.uri.toString())
      editor.setDecorations(this.decoration, ranges ?? [])
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    this.decoration.dispose()
    this.rangesByUri.clear()
  }
}
