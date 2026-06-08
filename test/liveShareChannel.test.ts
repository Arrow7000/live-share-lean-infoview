/**
 * Unit-test the LiveShareChannel adapter against a faithful in-process mock of
 * vsls `SharedService` / `SharedServiceProxy`. This exercises the exact API
 * shape Live Share exposes (host onRequest/onNotify/notify; guest
 * request/notify/onNotify) without needing a real session — so the only thing
 * left unverified for the real transport is Live Share's own plumbing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GuestEditorClient } from '../src/bridge/guestEditorClient.js'
import { LeanBridgeHost } from '../src/bridge/leanBridgeHost.js'
import {
  createGuestChannel,
  createHostChannel,
  type VslsSharedService,
  type VslsSharedServiceProxy,
} from '../src/bridge/liveShareChannel.js'
import type { Disposable, LeanClientLike } from '../src/bridge/types.js'

/** A connected mock pair mimicking vsls shareService/getSharedService. */
function mockVslsPair(): { service: VslsSharedService; proxy: VslsSharedServiceProxy } {
  const requestHandlers = new Map<string, (args: any[]) => any>()
  const serviceNotifyHandlers = new Map<string, Set<(args: object) => void>>()
  const proxyNotifyHandlers = new Map<string, Set<(args: object) => void>>()

  const service: VslsSharedService = {
    onRequest: (name, handler) => void requestHandlers.set(name, handler),
    onNotify: (name, handler) => {
      const set = serviceNotifyHandlers.get(name) ?? new Set()
      set.add(handler)
      serviceNotifyHandlers.set(name, set)
    },
    // Host -> guests broadcast.
    notify: (name, args) => {
      for (const h of [...(proxyNotifyHandlers.get(name) ?? [])]) queueMicrotask(() => h(args))
    },
  }

  const proxy: VslsSharedServiceProxy = {
    request: async (name, args) => {
      const handler = requestHandlers.get(name)
      if (!handler) throw new Error(`no service handler for '${name}'`)
      // Simulate the wire: JSON round-trip + async hop.
      const wire = JSON.parse(JSON.stringify(args))
      return JSON.parse(JSON.stringify((await handler(wire)) ?? null))
    },
    onNotify: (name, handler) => {
      const set = proxyNotifyHandlers.get(name) ?? new Set()
      set.add(handler)
      proxyNotifyHandlers.set(name, set)
    },
    // Guest -> host.
    notify: (name, args) => {
      for (const h of [...(serviceNotifyHandlers.get(name) ?? [])]) queueMicrotask(() => h(args))
    },
  }
  return { service, proxy }
}

class StubLeanClient implements LeanClientLike {
  notifications: Array<{ method: string; params: unknown }> = []
  private handlers = new Map<string, Set<(p: unknown) => void>>()
  async sendRequest<T = unknown>(method: string, _params: unknown): Promise<T> {
    if (method === '$/lean/rpc/connect') return { sessionId: 'ls-session' } as T
    if (method === '$/lean/rpc/call') return { goals: [{ hyps: [], type: { text: 'p ∧ q' } }] } as T
    return null as T
  }
  async sendNotification(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params })
  }
  onServerNotification(method: string, handler: (p: unknown) => void): Disposable {
    const set = this.handlers.get(method) ?? new Set()
    set.add(handler)
    this.handlers.set(method, set)
    return { dispose: () => set.delete(handler) }
  }
  getInitializeResult() {
    return { serverInfo: { name: 'Lean 4 Server', version: '0.3.0' }, capabilities: { experimental: { rpcProvider: {} } } }
  }
  getDiagnostics() {
    return [{ uri: 'vsls:/x.lean', diagnostics: [{ range: { start: { line: 16, character: 0 } }, leanTags: [2] }] }]
  }
  emit(method: string, params: unknown) {
    for (const h of [...(this.handlers.get(method) ?? [])]) h(params)
  }
}

test('LiveShareChannel: full guest<->host round-trip over mock vsls', async t => {
  const { service, proxy } = mockVslsPair()
  const client = new StubLeanClient()
  const host = new LeanBridgeHost(createHostChannel(service), client)
  const guest = new GuestEditorClient(createGuestChannel(proxy))

  await t.test('request: createRpcSession reaches the server through Live Share', async () => {
    const sessionId = await guest.createRpcSession('vsls:/x.lean')
    assert.equal(sessionId, 'ls-session')
  })

  await t.test('request: sendClientRequest returns the goal', async () => {
    const goals = (await guest.sendClientRequest('vsls:/x.lean', '$/lean/rpc/call', { sessionId: 'ls-session' })) as {
      goals: unknown[]
    }
    assert.equal(goals.goals.length, 1)
  })

  await t.test('request: getServerInitializeResult crosses the channel', async () => {
    const init = await guest.getServerInitializeResult()
    assert.equal(init?.serverInfo?.version, '0.3.0')
  })

  await t.test('request: getDiagnostics (with leanTags) crosses the channel', async () => {
    const diags = await guest.getDiagnostics()
    assert.equal(diags.length, 1)
    assert.deepEqual((diags[0].diagnostics[0] as { leanTags: number[] }).leanTags, [2])
  })

  await t.test('host -> guest notification is delivered via notify/onNotify', async () => {
    const received: unknown[] = []
    guest.onServerNotification('$/lean/fileProgress', p => received.push(p))
    await guest.subscribeServerNotifications('$/lean/fileProgress')
    client.emit('$/lean/fileProgress', { processing: [] })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(received.length, 1)
    assert.deepEqual(received[0], { processing: [] })
  })

  host.dispose()
  guest.dispose()
})
