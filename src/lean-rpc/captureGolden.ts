/**
 * Capture a golden interactive-goals payload from a real Lean server, so the
 * webview render smoke test can replay it deterministically with no server.
 *
 * Run: npm run capture:golden
 * Writes fixtures/golden/goldenGoals.json.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startElaboratedFixture } from './fixtureServer.js'
import type { InteractiveGoals, InteractiveTermGoal } from './leanRpcTypes.js'

const here = dirname(fileURLToPath(import.meta.url))
export const GOLDEN_DIR = resolve(here, '../../fixtures/golden')
export const GOLDEN_FILE = join(GOLDEN_DIR, 'goldenGoals.json')

export interface GoldenGoals {
  uri: string
  position: { line: number; character: number }
  location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
  initializeResult: { serverInfo: unknown; capabilities: unknown }
  goals: InteractiveGoals
  termGoal: InteractiveTermGoal | null
}

export async function captureGolden(log: (line: string) => void = () => {}): Promise<GoldenGoals> {
  const { conn, uri, position } = await startElaboratedFixture(log)
  try {
    const sessionId = await conn.rpcConnect(uri)
    let goals: InteractiveGoals | undefined
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      goals = await conn.getInteractiveGoals(sessionId, uri, position)
      if (goals && goals.goals.length > 0) break
      await new Promise(r => setTimeout(r, 300))
    }
    if (!goals || goals.goals.length === 0) throw new Error('no goals captured')
    const termGoal = (await conn.getInteractiveTermGoal(sessionId, uri, position)) ?? null

    return {
      uri,
      position,
      location: { uri, range: { start: position, end: position } },
      initializeResult: { serverInfo: conn.serverInfo, capabilities: conn.capabilities },
      goals,
      termGoal,
    }
  } finally {
    await conn.dispose()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  captureGolden(line => console.error(line))
    .then(async golden => {
      await mkdir(GOLDEN_DIR, { recursive: true })
      await writeFile(GOLDEN_FILE, JSON.stringify(golden, null, 2) + '\n', 'utf8')
      console.log(`wrote ${GOLDEN_FILE}`)
      console.log(`goals: ${golden.goals.goals.length}, termGoal: ${golden.termGoal ? 'yes' : 'no'}`)
      process.exit(0)
    })
    .catch(err => {
      console.error('capture failed:', err)
      process.exit(1)
    })
}
