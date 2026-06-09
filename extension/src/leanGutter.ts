import * as vscode from 'vscode'
import {
  computeDiagnosticGutterIcons,
  DIAGNOSTIC_GUTTER_KINDS,
  type GutterDiagnostic,
} from '../../src/gutter/diagnosticGutterIcons.js'

/** Lean's editor gutter signals, mirrored on the guest from forwarded data. */

// LeanFileProgressKind
const PROGRESS_PROCESSING = 1
const PROGRESS_FATAL_ERROR = 2
// LeanTag
const TAG_UNSOLVED_GOALS = 1

interface FileProgressLike {
  textDocument?: { uri?: string }
  processing?: { range: { start: { line: number }; end: { line: number } }; kind?: number }[]
}
interface PublishDiagnosticsLike {
  uri?: string
  diagnostics?: (GutterDiagnostic & { leanTags?: number[] })[]
}

interface UriDecorations {
  processing: vscode.Range[]
  fatalError: vscode.Range[]
  unsolvedGoals: vscode.Range[]
  /** Diagnostic gutter icons (error/warning/✓ + connectors) keyed by icon kind. */
  diagnosticIcons: Map<string, vscode.Range[]>
}

function emptyDecorations(): UriDecorations {
  return { processing: [], fatalError: [], unsolvedGoals: [], diagnosticIcons: new Map() }
}

/**
 * Renders the Lean editor gutter decorations on a guest, from forwarded
 * `$/lean/fileProgress` and `textDocument/publishDiagnostics`. Mirrors
 * vscode-lean4's `taskgutter.ts`:
 *   - orange "processing" bar (gutter + overview ruler) while elaborating,
 *   - red "fatal error" bar where the worker died,
 *   - error / warning / "goals accomplished" gutter icons with the same
 *     `-i/-l/-t[-passthrough]` connectors over a diagnostic's range,
 *   - the 🛠 "unsolved goals" end-of-line marker.
 */
export class LeanGutter {
  private readonly processing: vscode.TextEditorDecorationType
  private readonly fatalError: vscode.TextEditorDecorationType
  private readonly unsolvedGoals: vscode.TextEditorDecorationType
  private readonly diagnosticIconTypes = new Map<string, vscode.TextEditorDecorationType>()

  private readonly byUri = new Map<string, UriDecorations>()
  private readonly subs: vscode.Disposable[] = []

  constructor(extensionUri: vscode.Uri) {
    const asset = (...p: string[]) => vscode.Uri.joinPath(extensionUri, 'assets', ...p)

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
    this.unsolvedGoals = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: { contentText: '🛠', color: new vscode.ThemeColor('editorInfo.foreground'), margin: '0 0 0 1ch' },
    })
    for (const kind of DIAGNOSTIC_GUTTER_KINDS) {
      this.diagnosticIconTypes.set(
        kind,
        vscode.window.createTextEditorDecorationType({
          light: { gutterIconPath: asset('diagnostic-gutter-icons', `${kind}-light.svg`), gutterIconSize: '100%' },
          dark: { gutterIconPath: asset('diagnostic-gutter-icons', `${kind}-dark.svg`), gutterIconSize: '100%' },
        }),
      )
    }

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

  /** Update diagnostic gutter icons + unsolved-goals markers from `publishDiagnostics`. */
  updateDiagnostics(params: PublishDiagnosticsLike): void {
    const uri = params.uri
    if (!uri) return
    const diagnostics = params.diagnostics ?? []
    const entry = this.byUri.get(uri) ?? emptyDecorations()

    const icons = new Map<string, vscode.Range[]>()
    for (const { line, kind } of computeDiagnosticGutterIcons(diagnostics)) {
      const ranges = icons.get(kind) ?? []
      ranges.push(new vscode.Range(line, 0, line, 0))
      icons.set(kind, ranges)
    }
    entry.diagnosticIcons = icons

    entry.unsolvedGoals = diagnostics
      .filter(d => d.leanTags?.includes(TAG_UNSOLVED_GOALS))
      .map(d => new vscode.Range(d.range.start.line, 0, d.range.start.line, 0))

    this.byUri.set(uri, entry)
    this.apply()
  }

  private apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const d = this.byUri.get(editor.document.uri.toString()) ?? emptyDecorations()
      editor.setDecorations(this.processing, d.processing)
      editor.setDecorations(this.fatalError, d.fatalError)
      editor.setDecorations(this.unsolvedGoals, d.unsolvedGoals)
      for (const [kind, type] of this.diagnosticIconTypes) {
        editor.setDecorations(type, d.diagnosticIcons.get(kind) ?? [])
      }
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    this.processing.dispose()
    this.fatalError.dispose()
    this.unsolvedGoals.dispose()
    for (const t of this.diagnosticIconTypes.values()) t.dispose()
    this.diagnosticIconTypes.clear()
    this.byUri.clear()
  }
}
