/**
 * M1 integration test. Spawns a real Lean server against the fixture and
 * asserts the full custom-RPC round-trip yields a non-empty, correct goal.
 *
 * This is the permanent regression fixture for the riskiest part of the
 * project: the custom-RPC story (connect -> call -> interactive goals).
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { runM1Spike } from '../src/lean-rpc/m1-spike.js'
import { flattenTaggedText } from '../src/lean-rpc/leanRpcTypes.js'

const logs: string[] = []
const log = (line: string) => logs.push(line)

test('M1: custom RPC returns the expected interactive goal', { timeout: 120_000 }, async t => {
  let result
  try {
    result = await runM1Spike({ log })
  } catch (err) {
    console.error(logs.join('\n'))
    throw err
  }

  await t.test('a session was established', () => {
    assert.ok(result.sessionId.length > 0, 'expected a non-empty RPC session id')
  })

  await t.test('exactly one goal is returned at the tactic position', () => {
    assert.equal(result.goals.goals.length, 1)
  })

  await t.test('the goal target is `p ∧ q`', () => {
    const target = flattenTaggedText(result.goals.goals[0].type)
    assert.match(target, /p\s*∧\s*q/, `unexpected goal target: ${target}`)
  })

  await t.test('the hypotheses include hp : p and hq : q', () => {
    const hypText = result.goals.goals[0].hyps
      .map(h => `${h.names.join(' ')} : ${flattenTaggedText(h.type)}`)
      .join('\n')
    assert.match(hypText, /hp\s*:\s*p/, `missing hp : p in:\n${hypText}`)
    assert.match(hypText, /hq\s*:\s*q/, `missing hq : q in:\n${hypText}`)
  })

  await t.test('the Lean server advertises an rpc provider capability', () => {
    const exp = result.experimentalCapabilities as { rpcProvider?: unknown } | undefined
    assert.ok(exp?.rpcProvider !== undefined, `expected experimental.rpcProvider, got ${JSON.stringify(exp)}`)
  })
})

after(() => {
  // Surface the spike log on completion for debugging in CI output.
  if (process.env.M1_VERBOSE) console.error(logs.join('\n'))
})
