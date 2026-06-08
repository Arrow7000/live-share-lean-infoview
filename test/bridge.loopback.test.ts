/**
 * M2 data-plane integration test over the in-process loopback transport.
 *
 * Stands up a REAL Lean server behind the host bridge and a fake guest on the
 * other end of a `LoopbackChannel`, then drives connect -> call -> goals and a
 * server-notification subscription end to end — no GUI, no Live Share. This is
 * the bulk of the integration risk, exercised without any infrastructure.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { GuestEditorClient } from '../src/bridge/guestEditorClient.js'
import { LeanBridgeHost } from '../src/bridge/leanBridgeHost.js'
import { createLoopbackPair } from '../src/bridge/loopbackChannel.js'
import { startElaboratedFixture, type ElaboratedFixture } from '../src/lean-rpc/fixtureServer.js'
import { flattenTaggedText } from '../src/lean-rpc/leanRpcTypes.js'
import { driveGoalsThroughGuest } from './support/driveGoals.js'

const logs: string[] = []
const log = (line: string) => logs.push(line)

let fixture: ElaboratedFixture
let host: LeanBridgeHost
let guest: GuestEditorClient

before(async () => {
  fixture = await startElaboratedFixture(log)
  const [hostChannel, guestChannel] = createLoopbackPair()
  host = new LeanBridgeHost(hostChannel, fixture.conn, { log })
  guest = new GuestEditorClient(guestChannel)
})

after(async () => {
  guest?.dispose()
  host?.dispose()
  await fixture?.conn.dispose()
  if (process.env.M2_VERBOSE) console.error(logs.join('\n'))
})

test('M2 loopback: goals round-trip through the bridge', { timeout: 120_000 }, async t => {
  let result
  try {
    result = await driveGoalsThroughGuest(guest, fixture.uri, fixture.position)
  } catch (err) {
    console.error(logs.join('\n'))
    throw err
  }

  await t.test('a session id came back from the host bridge', () => {
    assert.ok(result.sessionId.length > 0)
  })

  await t.test('exactly one goal with target `p ∧ q`', () => {
    assert.equal(result.goals.goals.length, 1)
    assert.match(flattenTaggedText(result.goals.goals[0].type), /p\s*∧\s*q/)
  })

  await t.test('hypotheses survive the serialization boundary', () => {
    const hyps = result.goals.goals[0].hyps
      .map(h => `${h.names.join(' ')} : ${flattenTaggedText(h.type)}`)
      .join('\n')
    assert.match(hyps, /hp\s*:\s*p/)
    assert.match(hyps, /hq\s*:\s*q/)
  })

  await t.test('round-trip latency through the bridge is small', () => {
    assert.ok(result.latencyMs < 5000, `unexpectedly slow: ${result.latencyMs}ms`)
  })
})
