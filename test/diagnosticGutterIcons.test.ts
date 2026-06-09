import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeDiagnosticGutterIcons, type GutterDiagnostic } from '../src/gutter/diagnosticGutterIcons.js'

const err = (startLine: number, endLine: number, endChar = 5): GutterDiagnostic => ({
  severity: 1,
  range: { start: { line: startLine }, end: { line: endLine, character: endChar } },
  fullRange: { start: { line: startLine }, end: { line: endLine, character: endChar } },
})
const warn = (line: number): GutterDiagnostic => ({
  severity: 2,
  range: { start: { line }, end: { line, character: 3 } },
})
const accomplished = (line: number): GutterDiagnostic => ({
  // silent informational marker (not an error), tagged GoalsAccomplished
  severity: 3,
  range: { start: { line }, end: { line, character: 0 } },
  leanTags: [2],
})

test('single-line error → one `error` icon', () => {
  assert.deepEqual(computeDiagnosticGutterIcons([err(10, 10)]), [{ line: 10, kind: 'error' }])
})

test('multi-line error → init icon + connector down to the end', () => {
  const icons = computeDiagnosticGutterIcons([err(10, 13)])
  assert.deepEqual(icons, [
    { line: 10, kind: 'error-init' },
    { line: 11, kind: 'error-i' },
    { line: 12, kind: 'error-i' },
    { line: 13, kind: 'error-l' },
  ])
})

test('end.character === 0 makes the end line exclusive', () => {
  const icons = computeDiagnosticGutterIcons([err(10, 12, 0)])
  // inclusive end line is 11, not 12
  assert.deepEqual(icons.map(i => i.line), [10, 11])
  assert.equal(icons.at(-1)?.kind, 'error-l')
})

test('warning and goals-accomplished are single-line icons', () => {
  assert.deepEqual(computeDiagnosticGutterIcons([warn(4)]), [{ line: 4, kind: 'warning' }])
  assert.deepEqual(computeDiagnosticGutterIcons([accomplished(7)]), [
    { line: 7, kind: 'goals-accomplished-checkmark' },
  ])
})

test('a diagnostic starting inside another error range yields a passthrough variant', () => {
  // error spanning 10..13, plus a warning starting at line 12 (inside the error)
  const icons = computeDiagnosticGutterIcons([err(10, 13), warn(12)])
  const at12 = icons.find(i => i.line === 12)
  assert.equal(at12?.kind, 'warning-i-passthrough', 'warning at a continuing-error line should pass through')
})

test('info/hint diagnostics produce no gutter icon', () => {
  const info: GutterDiagnostic = { severity: 3, range: { start: { line: 1 }, end: { line: 1, character: 2 } } }
  assert.deepEqual(computeDiagnosticGutterIcons([info]), [])
})
