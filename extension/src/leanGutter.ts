import * as vscode from 'vscode'

/** Lean's editor gutter signals, mirrored on the guest from forwarded data. */

// LeanFileProgressKind
const PROGRESS_PROCESSING = 1
const PROGRESS_FATAL_ERROR = 2
// LeanTag
const TAG_UNSOLVED_GOALS = 1
const TAG_GOALS_ACCOMPLISHED = 2

interface FileProgressLike {
  textDocument?: { uri?: string }
  processing?: { range: { start: { line: number }; end: { line: number } }; kind?: number }[]
}
interface DiagnosticLike {
  range: { start: { line: number }; end: { line: number } }
  leanTags?: number[]
}
interface PublishDiagnosticsLike {
  uri?: string
  diagnostics?: DiagnosticLike[]
}

interface UriDecorations {
  processing: vscode.Range[]
  fatalError: vscode.Range[]
  goalsAccomplished: vscode.Range[]
  unsolvedGoals: vscode.Range[]
}

function emptyDecorations(): UriDecorations {
  return { processing: [], fatalError: [], goalsAccomplished: [], unsolvedGoals: [] }
}

/**
 * Renders the Lean editor gutter decorations on a guest, from forwarded
 * `$/lean/fileProgress` and `textDocument/publishDiagnostics`. Mirrors
 * vscode-lean4's `taskgutter.ts`:
 *   - orange "processing" bar (gutter + overview ruler) while elaborating,
 *   - red "fatal error" bar where the worker died,
 *   - blue "goals accomplished" ✓ checkmark for completed proofs,
 *   - the 🛠 "unsolved goals" end-of-line marker.
 *
 * Simplified vs upstream: no multi-line passthrough connectors, no
 * config-driven icon styles, and we let VS Code layer overlapping decorations.
 */
export class LeanGutter {
  private readonly processing: vscode.TextEditorDecorationType
  private readonly fatalError: vscode.TextEditorDecorationType
  private readonly goalsAccomplished: vscode.TextEditorDecorationType
  private readonly unsolvedGoals: vscode.TextEditorDecorationType

  private readonly byUri = new Map<string, UriDecorations>()
  private readonly subs: vscode.Disposable[] = []

  constructor(extensionUri: vscode.Uri) {
    const asset = (f: string) => vscode.Uri.joinPath(extensionUri, 'assets', f)

    this.processing = vscode.window.createTextEditorDecorationType({
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: 'rgba(255, 165, 0, 0.5)',
      gutterIconPath: asset('progress.svg'),
      gutterIconSize: 'contain',
    })
    this.fatalError = vscode.window.createTextEditorDecorationType({
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: 'rgba(255, 0, 0, 0.5)',
      gutterIconPath: asset('progress-error.svg'),
      gutterIconSize: 'contain',
    })
    this.goalsAccomplished = vscode.window.createTextEditorDecorationType({
      light: { gutterIconPath: asset('goals-accomplished-light.svg'), gutterIconSize: 'contain' },
      dark: { gutterIconPath: asset('goals-accomplished-dark.svg'), gutterIconSize: 'contain' },
    })
    const unsolvedColor = new vscode.ThemeColor('editorInfo.foreground')
    this.unsolvedGoals = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: { contentText: '🛠', color: unsolvedColor, margin: '0 0 0 1ch' },
    })

    this.subs.push(vscode.window.onDidChangeVisibleTextEditors(() => this.apply()))
  }

  /** Update processing / fatal-error ranges from a `$/lean/fileProgress`. */
  updateProgress(params: FileProgressLike): void {
    const uri = params.textDocument?.uri
    if (!uri) return
    const entry = this.byUri.get(uri) ?? emptyDecorations()
    entry.processing = []
    entry.fatalError = []
    for (const p of params.processing ?? []) {
      const range = new vscode.Range(p.range.start.line, 0, p.range.end.line, 0)
      if (p.kind === PROGRESS_FATAL_ERROR) entry.fatalError.push(range)
      else if (p.kind === undefined || p.kind === PROGRESS_PROCESSING) entry.processing.push(range)
    }
    this.byUri.set(uri, entry)
    this.apply()
  }

  /** Update goals-accomplished / unsolved-goals ranges from a `publishDiagnostics`. */
  updateDiagnostics(params: PublishDiagnosticsLike): void {
    const uri = params.uri
    if (!uri) return
    const entry = this.byUri.get(uri) ?? emptyDecorations()
    entry.goalsAccomplished = []
    entry.unsolvedGoals = []
    for (const d of params.diagnostics ?? []) {
      const line = d.range.start.line
      if (d.leanTags?.includes(TAG_GOALS_ACCOMPLISHED)) entry.goalsAccomplished.push(new vscode.Range(line, 0, line, 0))
      if (d.leanTags?.includes(TAG_UNSOLVED_GOALS)) entry.unsolvedGoals.push(new vscode.Range(line, 0, line, 0))
    }
    this.byUri.set(uri, entry)
    this.apply()
  }

  private apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const d = this.byUri.get(editor.document.uri.toString()) ?? emptyDecorations()
      editor.setDecorations(this.processing, d.processing)
      editor.setDecorations(this.fatalError, d.fatalError)
      editor.setDecorations(this.goalsAccomplished, d.goalsAccomplished)
      editor.setDecorations(this.unsolvedGoals, d.unsolvedGoals)
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    this.processing.dispose()
    this.fatalError.dispose()
    this.goalsAccomplished.dispose()
    this.unsolvedGoals.dispose()
    this.byUri.clear()
  }
}
