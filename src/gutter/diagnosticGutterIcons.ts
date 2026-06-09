/**
 * Pure port of vscode-lean4's diagnostic gutter-icon computation
 * (`taskgutter.ts`): given the Lean diagnostics for a file, decide which gutter
 * icon to draw on each line — the error/warning/goals-accomplished icon at the
 * start, plus the `-i/-l/-t[-passthrough]` connector variants down a diagnostic's
 * range (and where ranges overlap). Framework-agnostic so it's unit-tested.
 *
 * Severities are LSP 1-based (Error=1, Warning=2), matching the raw Lean
 * `publishDiagnostics` params we forward.
 */

const SEVERITY_ERROR = 1
const SEVERITY_WARNING = 2
const TAG_GOALS_ACCOMPLISHED = 2

const GOALS_ACCOMPLISHED_NAME = 'goals-accomplished-checkmark'

export interface GutterDiagnostic {
  range: { start: { line: number; character?: number }; end: { line: number; character: number } }
  fullRange?: { start: { line: number }; end: { line: number; character: number } }
  severity?: number
  leanTags?: number[]
}

type StartKind = 'Error' | 'Warning' | 'GoalsAccomplished'
type DiagStart = 'None' | { kind: StartKind; range: 'SingleLine' | 'MultiLine' }

interface GutterDeco {
  line: number
  diagStart: DiagStart
  isPreviousDiagContinue: boolean
  isPreviousDiagEnd: boolean
}

function isGoalsAccomplished(d: GutterDiagnostic): boolean {
  return d.leanTags?.some(t => t === TAG_GOALS_ACCOMPLISHED) ?? false
}

function isGutterDecoDiagnostic(d: GutterDiagnostic): boolean {
  return d.severity === SEVERITY_ERROR || d.severity === SEVERITY_WARNING || isGoalsAccomplished(d)
}

function diagRange(d: GutterDiagnostic) {
  if (d.severity !== SEVERITY_ERROR) return d.range
  return d.fullRange ?? d.range
}

function inclusiveEndLine(r: { start: { line: number }; end: { line: number; character: number } }): number {
  if (r.start.line === r.end.line) return r.end.line
  if (r.end.character === 0) return r.end.line - 1
  return r.end.line
}

function startKindPrio(k: StartKind): number {
  return k === 'Error' ? 2 : k === 'Warning' ? 1 : 0
}
function startRangePrio(r: 'SingleLine' | 'MultiLine'): number {
  return r === 'MultiLine' ? 1 : 0
}

function mergeDiagStarts(a: DiagStart, b: DiagStart): DiagStart {
  if (a === 'None') return b
  if (b === 'None') return a
  return {
    kind: startKindPrio(a.kind) >= startKindPrio(b.kind) ? a.kind : b.kind,
    range: startRangePrio(a.range) >= startRangePrio(b.range) ? a.range : b.range,
  }
}

function mergeDecos(a: GutterDeco, b: GutterDeco): GutterDeco {
  return {
    line: a.line,
    diagStart: mergeDiagStarts(a.diagStart, b.diagStart),
    isPreviousDiagContinue: a.isPreviousDiagContinue || b.isPreviousDiagContinue,
    isPreviousDiagEnd: a.isPreviousDiagEnd || b.isPreviousDiagEnd,
  }
}

function determineDiagStart(d: GutterDiagnostic, startLine: number, endLine: number, line: number): DiagStart {
  if (line !== startLine) return 'None'
  if (d.severity === SEVERITY_ERROR) return { kind: 'Error', range: startLine === endLine ? 'SingleLine' : 'MultiLine' }
  if (d.severity === SEVERITY_WARNING) return { kind: 'Warning', range: 'SingleLine' }
  if (isGoalsAccomplished(d)) return { kind: 'GoalsAccomplished', range: 'SingleLine' }
  return 'None'
}

function determineDeco(d: GutterDiagnostic, startLine: number, endLine: number, line: number): GutterDeco {
  const diagStart = determineDiagStart(d, startLine, endLine, line)
  if (diagStart !== 'None') {
    return { line, diagStart, isPreviousDiagContinue: false, isPreviousDiagEnd: false }
  }
  return { line, diagStart, isPreviousDiagContinue: line < endLine, isPreviousDiagEnd: line === endLine }
}

function singleLineKind(d: GutterDeco, name: string): string {
  const c = d.isPreviousDiagContinue
  const e = d.isPreviousDiagEnd
  if (!c && !e) return name
  if (!c && e) return `${name}-l-passthrough`
  if (c && !e) return `${name}-i-passthrough`
  return `${name}-t-passthrough`
}

function decoKind(d: GutterDeco): string | undefined {
  const s = d.diagStart
  const c = d.isPreviousDiagContinue
  const e = d.isPreviousDiagEnd
  if (s !== 'None') {
    if (s.kind === 'Error') {
      if (!c && !e) return s.range === 'SingleLine' ? 'error' : 'error-init'
      if (!c && e) return s.range === 'SingleLine' ? 'error-l-passthrough' : 'error-t-passthrough'
      if (c && !e) return 'error-i-passthrough'
      return 'error-t-passthrough'
    }
    if (s.kind === 'Warning') return singleLineKind(d, 'warning')
    return singleLineKind(d, GOALS_ACCOMPLISHED_NAME)
  }
  if (!c && !e) return undefined
  if (!c && e) return 'error-l'
  if (c && !e) return 'error-i'
  return 'error-t'
}

/** All gutter-icon kinds this module can emit (each needs a decoration type). */
export const DIAGNOSTIC_GUTTER_KINDS: readonly string[] = [
  'error',
  'error-init',
  'error-i',
  'error-i-passthrough',
  'error-l',
  'error-l-passthrough',
  'error-t',
  'error-t-passthrough',
  'warning',
  'warning-i-passthrough',
  'warning-l-passthrough',
  'warning-t-passthrough',
  GOALS_ACCOMPLISHED_NAME,
  `${GOALS_ACCOMPLISHED_NAME}-i-passthrough`,
  `${GOALS_ACCOMPLISHED_NAME}-l-passthrough`,
  `${GOALS_ACCOMPLISHED_NAME}-t-passthrough`,
]

/** Compute the gutter icon kind for each affected line. */
export function computeDiagnosticGutterIcons(diagnostics: readonly GutterDiagnostic[]): Array<{ line: number; kind: string }> {
  const decos = new Map<number, GutterDeco>()
  const update = (deco: GutterDeco) => {
    const old = decos.get(deco.line)
    decos.set(deco.line, old ? mergeDecos(old, deco) : deco)
  }
  for (const d of diagnostics) {
    if (!isGutterDecoDiagnostic(d)) continue
    const range = diagRange(d)
    const startLine = range.start.line
    const endLine = inclusiveEndLine(range)
    const startDeco = determineDeco(d, startLine, endLine, startLine)
    update(startDeco)
    if (startDeco.diagStart !== 'None' && startDeco.diagStart.range === 'SingleLine') continue
    for (let line = startLine + 1; line <= endLine; line++) update(determineDeco(d, startLine, endLine, line))
  }
  const result: Array<{ line: number; kind: string }> = []
  for (const deco of [...decos.values()].sort((a, b) => a.line - b.line)) {
    const kind = decoKind(deco)
    if (kind !== undefined) result.push({ line: deco.line, kind })
  }
  return result
}
