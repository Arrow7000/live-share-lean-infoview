/**
 * Fast, deterministic bridge unit tests with a stub Lean client (no real
 * server). Each test runs over BOTH the loopback and WebSocket transports to
 * prove the bridge is genuinely transport-agnostic.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { GuestEditorClient } from '../src/bridge/guestEditorClient.js'
import { LeanBridgeHost } from '../src/bridge/leanBridgeHost.js'
import { createLoopbackPair } from '../src/bridge/loopbackChannel.js'
import type { BridgeChannel, Disposable, LeanClientLike } from '../src/bridge/types.js'
import {
  connectWebSocketGuest,
  startWebSocketHost,
  type WebSocketHost,
} from '../src/bridge/webSocketChannel.js'

class StubLeanClient implements LeanClientLike {
  requests: Array<{ method: string; params: unknown }> = []
  notifications: Array<{ method: string; params: unknown }> = []
  private handlers = new Map<string, Set<(p: unknown) => void>>()

  async sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === '$/lean/rpc/connect') return { sessionId: 'stub-session-1' } as T
    if (method === '$/lean/rpc/call') return { goals: [{ hyps: [], type: { text: 'True' } }] } as T
    return null as T
  }
  async sendNotification(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params })
  }
  onServerNotification(method: string, handler: (p: unknown) => void): Disposable {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return { dispose: () => set!.delete(handler) }
  }
  emit(method: string, params: unknown) {
    for (const h of [...(this.handlers.get(method) ?? [])]) h(params)
  }
}

interface Pair {
  host: BridgeChannel
  guest: BridgeChannel
  cleanup: () => Promise<void>
}

async function loopbackPair(): Promise<Pair> {
  const [host, guest] = createLoopbackPair()
  return { host, guest, cleanup: async () => {} }
}

let wsHosts: WebSocketHost[] = []
async function webSocketPair(): Promise<Pair> {
  const wsHost = await startWebSocketHost(0)
  wsHosts.push(wsHost)
  const [hostConn, guestConn] = await Promise.all([
    wsHost.nextConnection(),
    connectWebSocketGuest(`ws://127.0.0.1:${wsHost.port}`),
  ])
  return {
    host: hostConn,
    guest: guestConn,
    cleanup: async () => {
      hostConn.dispose()
      guestConn.dispose()
      await wsHost.close()
    },
  }
}

after(async () => {
  await Promise.all(wsHosts.map(h => h.close().catch(() => {})))
})

const transports: Array<[string, () => Promise<Pair>]> = [
  ['loopback', loopbackPair],
  ['websocket', webSocketPair],
]

for (const [name, makePair] of transports) {
  describe(`bridge over ${name}`, () => {
    test('createRpcSession forwards $/lean/rpc/connect and returns the session id', async () => {
      const { host, guest, cleanup } = await makePair()
      const client = new StubLeanClient()
      const bridge = new LeanBridgeHost(host, client, { keepAlivePeriodMs: 10_000 })
      const editor = new GuestEditorClient(guest)

      const sessionId = await editor.createRpcSession('file:///x.lean')
      assert.equal(sessionId, 'stub-session-1')
      assert.deepEqual(client.requests[0], { method: '$/lean/rpc/connect', params: { uri: 'file:///x.lean' } })

      bridge.dispose()
      editor.dispose()
      await cleanup()
    })

    test('sendClientRequest passes through method, params, and result', async () => {
      const { host, guest, cleanup } = await makePair()
      const client = new StubLeanClient()
      const bridge = new LeanBridgeHost(host, client)
      const editor = new GuestEditorClient(guest)

      const params = { sessionId: 's', method: 'Lean.Widget.getInteractiveGoals', params: {} }
      const result = (await editor.sendClientRequest('file:///x.lean', '$/lean/rpc/call', params)) as {
        goals: unknown[]
      }
      assert.equal(result.goals.length, 1)
      assert.equal(client.requests.at(-1)?.method, '$/lean/rpc/call')
      assert.deepEqual(client.requests.at(-1)?.params, params)

      bridge.dispose()
      editor.dispose()
      await cleanup()
    })

    test('sendClientNotification forwards release notifications', async () => {
      const { host, guest, cleanup } = await makePair()
      const client = new StubLeanClient()
      const bridge = new LeanBridgeHost(host, client)
      const editor = new GuestEditorClient(guest)

      await editor.sendClientNotification('file:///x.lean', '$/lean/rpc/release', { sessionId: 's', refs: [] })
      assert.deepEqual(client.notifications.at(-1), {
        method: '$/lean/rpc/release',
        params: { sessionId: 's', refs: [] },
      })

      bridge.dispose()
      editor.dispose()
      await cleanup()
    })

    test('the host owns keepalive: keepAlive notifications are sent on an interval', async () => {
      const { host, guest, cleanup } = await makePair()
      const client = new StubLeanClient()
      const bridge = new LeanBridgeHost(host, client, { keepAlivePeriodMs: 20 })
      const editor = new GuestEditorClient(guest)

      await editor.createRpcSession('file:///x.lean')
      await new Promise(r => setTimeout(r, 120))
      const keepAlives = client.notifications.filter(n => n.method === '$/lean/rpc/keepAlive')
      assert.ok(keepAlives.length >= 2, `expected >=2 keepalives, got ${keepAlives.length}`)
      assert.deepEqual(keepAlives[0].params, { uri: 'file:///x.lean', sessionId: 'stub-session-1' })

      bridge.dispose()
      const before = client.notifications.length
      await new Promise(r => setTimeout(r, 60))
      assert.equal(client.notifications.length, before, 'keepalive should stop after dispose')

      editor.dispose()
      await cleanup()
    })

    test('subscribed server notifications are forwarded; unsubscribe stops them', async () => {
      const { host, guest, cleanup } = await makePair()
      const client = new StubLeanClient()
      const bridge = new LeanBridgeHost(host, client)
      const editor = new GuestEditorClient(guest)

      const received: unknown[] = []
      editor.onServerNotification('$/lean/fileProgress', p => received.push(p))
      await editor.subscribeServerNotifications('$/lean/fileProgress')

      client.emit('$/lean/fileProgress', { processing: [] })
      await new Promise(r => setTimeout(r, 50))
      assert.equal(received.length, 1)
      assert.deepEqual(received[0], { processing: [] })

      await editor.unsubscribeServerNotifications('$/lean/fileProgress')
      client.emit('$/lean/fileProgress', { processing: [{ x: 1 }] })
      await new Promise(r => setTimeout(r, 50))
      assert.equal(received.length, 1, 'should not receive after unsubscribe')

      bridge.dispose()
      editor.dispose()
      await cleanup()
    })
  })
}
