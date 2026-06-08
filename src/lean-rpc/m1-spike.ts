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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Position } from 'vscode-languageserver-protocol'
import { startElaboratedFixture } from './fixtureServer.js'
import { type InteractiveGoals, renderGoal } from './leanRpcTypes.js'

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
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runM1Spike(opts: RunOptions = {}): Promise<M1Result> {
  const log = opts.log ?? (() => {})
  const { conn, uri, position, launchCommand } = await startElaboratedFixture(log)
  log(`fixture uri: ${uri}`)
  log(`goal position (0-indexed): line ${position.line}, char ${position.character}`)
  try {
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

    return {
      serverInfo: conn.serverInfo,
      experimentalCapabilities: (conn.capabilities as { experimental?: unknown } | undefined)?.experimental,
      sessionId,
      goalPosition: position,
      goals,
      renderedGoals: goals.goals.map(renderGoal),
      goalsLatencyMs,
      launchCommand,
    }
  } finally {
    await conn.dispose()
  }
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
