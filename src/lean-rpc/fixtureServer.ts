/**
 * Shared helpers to bring up the Lean fixture server to the point where it has
 * finished elaborating, with the deterministic goal position resolved. Used by
 * both the M1 spike and the M2 bridge integration tests.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Position } from 'vscode-languageserver-protocol'
import { fileUri, LeanServerConnection } from './leanServerConnection.js'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = resolve(here, '../../fixtures/lean-fixture')
export const FIXTURE_FILE = join(FIXTURE_DIR, 'Fixture.lean')

/** Launch commands to try, in order (production first, then no-import fallback). */
export const LAUNCH_COMMANDS: Array<{ command: string; args: string[] }> = [
  { command: 'lake', args: ['serve', '--'] },
  { command: 'lean', args: ['--server'] },
]

/** Locate the `exact` tactic line; return its 0-indexed LSP position + file text. */
export async function goalPositionFromFixture(): Promise<{ text: string; position: Position }> {
  const text = await readFile(FIXTURE_FILE, 'utf8')
  const lines = text.split('\n')
  const lineIndex = lines.findIndex(l => /^\s*exact\b/.test(l))
  if (lineIndex < 0) throw new Error('could not find `exact` tactic line in fixture')
  const character = lines[lineIndex].indexOf('exact')
  return { text, position: { line: lineIndex, character } }
}

export interface ElaboratedFixture {
  conn: LeanServerConnection
  uri: string
  text: string
  position: Position
  launchCommand: string
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

/**
 * Start the fixture server (trying each launch command), open the file, and
 * wait for elaboration to finish. The returned connection is ready for RPC.
 */
export async function startElaboratedFixture(log: (line: string) => void = () => {}): Promise<ElaboratedFixture> {
  const { text, position } = await goalPositionFromFixture()
  const uri = fileUri(FIXTURE_FILE)
  let lastError: unknown
  for (const { command, args } of LAUNCH_COMMANDS) {
    const conn = new LeanServerConnection({ cwd: FIXTURE_DIR, command, args, log })
    try {
      log(`--- launch via \`${command} ${args.join(' ')}\` ---`)
      await withTimeout(conn.start(), 20_000, 'initialize handshake')
      conn.trackDiagnostics()
      conn.openTextDocument(uri, text)
      await conn.waitForElaboration(uri, 45_000)
      return { conn, uri, text, position, launchCommand: `${command} ${args.join(' ')}` }
    } catch (err) {
      lastError = err
      log(`launch via \`${command}\` failed: ${err instanceof Error ? err.message : String(err)}`)
      await conn.dispose()
    }
  }
  throw new Error(`all launch attempts failed; last error: ${String(lastError)}`)
}
