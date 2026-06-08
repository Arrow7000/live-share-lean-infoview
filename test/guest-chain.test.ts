/**
 * M3 (headless part): exercise the FULL guest data path except the React render.
 *
 *   webview EditorApi proxy
 *     --Rpc/postMessage-->  guestEditorApi (start/await split)
 *       --GuestEditorClient--> loopback BridgeChannel
 *         --> LeanBridgeHost --> REAL Lean server --> interactive goals
 *
 * Everything the infoview webview would do to fetch a goal, minus drawing it.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { GuestEditorClient } from '../src/bridge/guestEditorClient.js'
import { LeanBridgeHost } from '../src/bridge/leanBridgeHost.js'
import { createLoopbackPair } from '../src/bridge/loopbackChannel.js'
import { createGuestEditorApi, type GuestEditorApi } from '../src/infoview/guestEditorApi.js'
import type { EditorApi, EditorRpcApi, InfoviewApi } from '../src/infoview/api.js'
import { editorApiOfRpc, Rpc } from '../src/infoview/rpc.js'
import { startElaboratedFixture, type ElaboratedFixture } from '../src/lean-rpc/fixtureServer.js'
import { flattenTaggedText, LeanRpcMethod, LeanWidgetRpc } from '../src/lean-rpc/leanRpcTypes.js'

const logs: string[] = []
const log = (l: string) => logs.push(l)

let fixture: ElaboratedFixture
let host: LeanBridgeHost
let guestClient: GuestEditorClient
let guestEditorApi: GuestEditorApi
let editorApi: EditorApi
const gotNotifications: Array<{ method: string; params: unknown }> = []

before(async () => {
  fixture = await startElaboratedFixture(log)

  // Bridge: host bridge <-> guest client over loopback, with a real Lean server.
  const [hostChannel, guestChannel] = createLoopbackPair()
  host = new LeanBridgeHost(hostChannel, fixture.conn, { log })
  guestClient = new GuestEditorClient(guestChannel)

  // Webview <-> extension-host hop: two Rpc endpoints wired directly.
  const rpcHost = new Rpc(m => rpcWebview.messageReceived(m))
  const rpcWebview = new Rpc(m => rpcHost.messageReceived(m))
  const rpcInfoview = rpcHost.getApi<InfoviewApi>()

  guestEditorApi = createGuestEditorApi(guestClient, {
    onServerNotification: (method, params) => void rpcInfoview.gotServerNotification(method, params),
    log,
  })
  rpcHost.register(guestEditorApi)

  // The webview registers an InfoviewApi; here we stub it to record calls.
  const fakeInfoview: InfoviewApi = {
    initialize: async () => {},
    gotServerNotification: async (method, params) => void gotNotifications.push({ method, params }),
    sentClientNotification: async () => {},
    serverRestarted: async () => {},
    serverStopped: async () => {},
    changedCursorLocation: async () => {},
    changedInfoviewConfig: async () => {},
    requestedAction: async () => {},
    clickedContextMenu: async () => {},
    runTestScript: async () => {},
    getInfoviewHtml: async () => '',
  }
  rpcWebview.register(fakeInfoview)

  editorApi = editorApiOfRpc(rpcWebview.getApi<EditorRpcApi>())
})

after(async () => {
  guestEditorApi?.dispose()
  guestClient?.dispose()
  host?.dispose()
  await fixture?.conn.dispose()
  if (process.env.M3_VERBOSE) console.error(logs.join('\n'))
})

test('M3 guest chain: goals flow webview->rpc->bridge->real Lean', { timeout: 120_000 }, async t => {
  const uri = fixture.uri
  const sessionId = await editorApi.createRpcSession(uri)

  const tdpp = { textDocument: { uri }, position: fixture.position }
  const callParams = {
    sessionId,
    method: LeanWidgetRpc.getInteractiveGoals,
    params: tdpp,
    textDocument: { uri },
    position: fixture.position,
  }

  let goals: { goals: Array<{ type: unknown; hyps: Array<{ names: string[]; type: unknown }> }> } | undefined
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    goals = (await editorApi.sendClientRequest(uri, LeanRpcMethod.call, callParams)) as typeof goals
    if (goals && goals.goals.length > 0) break
    await new Promise(r => setTimeout(r, 300))
  }

  await t.test('a session id crossed both hops', () => {
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0)
  })

  await t.test('goal target `p ∧ q` returns through the full chain', () => {
    assert.ok(goals && goals.goals.length === 1, 'expected exactly one goal')
    assert.match(flattenTaggedText(goals!.goals[0].type as any), /p\s*∧\s*q/)
  })

  await t.test('hypotheses survive the webview<->host serialization too', () => {
    const hyps = goals!.goals[0].hyps
      .map(h => `${h.names.join(' ')} : ${flattenTaggedText(h.type as any)}`)
      .join('\n')
    assert.match(hyps, /hp\s*:\s*p/)
    assert.match(hyps, /hq\s*:\s*q/)
  })
})
