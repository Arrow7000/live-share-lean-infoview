/**
 * M1 — headless host-RPC spike.
 *
 * Spawns a real Lean server on the one-theorem fixture, drives the custom RPC
 * end to end, and asserts a non-empty interactive goal comes back. No VS Code,
 * no Live Share, no display.
 *
 * Run directly:   npm run spike:m1
 * Run as a test:  npm run test:m1
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Position } from 'vscode-languageserver-protocol'
import { fileUri, LeanServerConnection, type LeanServerOptions } from './leanServerConnection.js'
import { type InteractiveGoals, renderGoal } from './leanRpcTypes.js'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = resolve(here, '../../fixtures/lean-fixture')
export const FIXTURE_FILE = join(FIXTURE_DIR, 'Fixture.lean')

export interface M1Result {
  serverInfo: { name?: string; version?: string } | undefined
  /** `experimental` capabilities, where Lean advertises its rpc/module providers. */
  experimentalCapabilities: unknown
  sessionId: string
  goalPosition: Position
  goals: InteractiveGoals
  renderedGoals: string[]
  /** Round-trip latency of the goals call, ms. */
  goalsLatencyMs: number
  launchCommand: string
}

interface RunOptions {
  log?: (line: string) => void
  /** Override the launch command list to try (each `[cmd, ...args]`). */
  commands?: Array<{ command: string; args: string[] }>
}

/** Locate the `exact` tactic line and return a 0-indexed LSP position at its start. */
async function goalPositionFromFixture(): Promise<{ text: string; position: Position }> {
  const text = await readFile(FIXTURE_FILE, 'utf8')
  const lines = text.split('\n')
  // Match the actual tactic line (`  exact ...`), not prose mentioning "exact".
  const lineIndex = lines.findIndex(l => /^\s*exact\b/.test(l))
  if (lineIndex < 0) throw new Error('could not find `exact` tactic line in fixture')
  const character = lines[lineIndex].indexOf('exact')
  return { text, position: { line: lineIndex, character } }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runM1Spike(opts: RunOptions = {}): Promise<M1Result> {
  const log = opts.log ?? (() => {})
  const { text, position } = await goalPositionFromFixture()
  const uri = fileUri(FIXTURE_FILE)
  log(`fixture uri: ${uri}`)
  log(`goal position (0-indexed): line ${position.line}, char ${position.character}`)

  const commands = opts.commands ?? [
    { command: 'lake', args: ['serve', '--'] }, // production launch
    { command: 'lean', args: ['--server'] }, // fallback (fixture has no imports)
  ]

  let lastError: unknown
  for (const { command, args } of commands) {
    const options: LeanServerOptions = { cwd: FIXTURE_DIR, command, args, log }
    const conn = new LeanServerConnection(options)
    try {
      log(`--- attempting launch via \`${command} ${args.join(' ')}\` ---`)
      const init = await withTimeout(conn.start(), 20_000, 'initialize handshake')
      conn.trackDiagnostics()
      conn.openTextDocument(uri, text)

      const elaboration = await conn.waitForElaboration(uri, 45_000)
      log(`elaboration: ${elaboration}`)

      const sessionId = await conn.rpcConnect(uri)
      log(`rpc session: ${sessionId}`)

      // Retry the goals call until elaboration has produced a goal at the position.
      let goals: InteractiveGoals | undefined
      let goalsLatencyMs = 0
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const t0 = Date.now()
        goals = await conn.getInteractiveGoals(sessionId, uri, position)
        goalsLatencyMs = Date.now() - t0
        if (goals && goals.goals.length > 0) break
        await sleep(300)
      }

      if (!goals || goals.goals.length === 0) {
        throw new Error('getInteractiveGoals returned no goals before deadline')
      }

      const renderedGoals = goals.goals.map(renderGoal)
      const result: M1Result = {
        serverInfo: init.serverInfo,
        experimentalCapabilities: (init.capabilities as { experimental?: unknown }).experimental,
        sessionId,
        goalPosition: position,
        goals,
        renderedGoals,
        goalsLatencyMs,
        launchCommand: `${command} ${args.join(' ')}`,
      }
      await conn.dispose()
      return result
    } catch (err) {
      lastError = err
      log(`launch via \`${command}\` failed: ${err instanceof Error ? err.message : String(err)}`)
      await conn.dispose()
    }
  }
  throw new Error(`all launch attempts failed; last error: ${String(lastError)}`)
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runM1Spike({ log: line => console.error(line) })
    .then(result => {
      console.log('\n================ M1 SPIKE RESULT ================')
      console.log(`launch command:   ${result.launchCommand}`)
      console.log(`server:           ${result.serverInfo?.name} ${result.serverInfo?.version}`)
      console.log(`experimental cap: ${JSON.stringify(result.experimentalCapabilities)}`)
      console.log(`session id:       ${result.sessionId}`)
      console.log(`goal position:    ${JSON.stringify(result.goalPosition)}`)
      console.log(`goals call RTT:   ${result.goalsLatencyMs}ms`)
      console.log(`number of goals:  ${result.goals.goals.length}`)
      console.log('------------------ rendered goals -----------------')
      for (const g of result.renderedGoals) console.log(g + '\n')
      console.log('=================================================')
      process.exit(0)
    })
    .catch(err => {
      console.error('\nM1 SPIKE FAILED:', err)
      process.exit(1)
    })
}
