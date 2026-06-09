import * as vscode from 'vscode'

interface FileProgressLike {
  textDocument?: { uri?: string }
  processing?: { range: { start: { line: number }; end: { line: number } } }[]
}

/**
 * Shows Lean's "elaborating" indicator on the guest — the orange bar in the
 * gutter and the overview ruler (minimap strip) — from forwarded
 * `$/lean/fileProgress` notifications. Mirrors vscode-lean4's processing
 * decoration (taskgutter.ts): `overviewRulerColor` orange on the Left lane plus
 * a per-line orange gutter bar.
 */
export class FileProgressGutter {
  private readonly decoration: vscode.TextEditorDecorationType
  private readonly rangesByUri = new Map<string, vscode.Range[]>()
  private readonly subs: vscode.Disposable[] = []

  constructor(extensionUri: vscode.Uri) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: 'rgba(255, 165, 0, 0.5)',
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'assets', 'progress.svg'),
      gutterIconSize: 'contain',
    })
    this.subs.push(vscode.window.onDidChangeVisibleTextEditors(() => this.apply()))
  }

  /** Update the processing ranges for a URI from a forwarded `$/lean/fileProgress`. */
  update(params: FileProgressLike): void {
    const uri = params.textDocument?.uri
    if (!uri) return
    const ranges = (params.processing ?? []).map(
      p => new vscode.Range(p.range.start.line, 0, p.range.end.line, 0),
    )
    if (ranges.length === 0) this.rangesByUri.delete(uri)
    else this.rangesByUri.set(uri, ranges)
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
