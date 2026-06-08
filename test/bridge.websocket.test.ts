/**
 * M2 data-plane integration over the WebSocket transport with a REAL Lean
 * server. Host and guest channels are connected through actual localhost
 * sockets (full JSON serialization), proving the bridge works over a transport
 * other than loopback — the same shape that Live Share's `shareServer(port)`
 * tunnel would use in production.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { GuestEditorClient } from '../src/bridge/guestEditorClient.js'
import { LeanBridgeHost } from '../src/bridge/leanBridgeHost.js'
import {
  connectWebSocketGuest,
  startWebSocketHost,
  type WebSocketChannel,
  type WebSocketHost,
} from '../src/bridge/webSocketChannel.js'
import { startElaboratedFixture, type ElaboratedFixture } from '../src/lean-rpc/fixtureServer.js'
import { flattenTaggedText } from '../src/lean-rpc/leanRpcTypes.js'
import { driveGoalsThroughGuest } from './support/driveGoals.js'

const logs: string[] = []
const log = (line: string) => logs.push(line)

let fixture: ElaboratedFixture
let wsHost: WebSocketHost
let hostChannel: WebSocketChannel
let guestChannel: WebSocketChannel
let host: LeanBridgeHost
let guest: GuestEditorClient

before(async () => {
  fixture = await startElaboratedFixture(log)
  wsHost = await startWebSocketHost(0)
  ;[hostChannel, guestChannel] = await Promise.all([
    wsHost.nextConnection(),
    connectWebSocketGuest(`ws://127.0.0.1:${wsHost.port}`),
  ])
  host = new LeanBridgeHost(hostChannel, fixture.conn, { log })
  guest = new GuestEditorClient(guestChannel)
})

after(async () => {
  guest?.dispose()
  host?.dispose()
  hostChannel?.dispose()
  guestChannel?.dispose()
  await wsHost?.close()
  await fixture?.conn.dispose()
  if (process.env.M2_VERBOSE) console.error(logs.join('\n'))
})

test('M2 websocket: goals round-trip through the bridge over real sockets', { timeout: 120_000 }, async () => {
  let result
  try {
    result = await driveGoalsThroughGuest(guest, fixture.uri, fixture.position)
  } catch (err) {
    console.error(logs.join('\n'))
    throw err
  }
  assert.ok(result.sessionId.length > 0)
  assert.equal(result.goals.goals.length, 1)
  assert.match(flattenTaggedText(result.goals.goals[0].type), /p\s*∧\s*q/)
})
