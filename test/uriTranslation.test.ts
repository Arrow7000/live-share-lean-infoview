/**
 * Unit tests for URI translation across the bridge boundary. Uses simple
 * scheme-swapping mappers in place of Live Share's real converters.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLoopbackPair } from '../src/bridge/loopbackChannel.js'
import { makeUriTranslatingHostChannel, remapUris } from '../src/bridge/uriTranslation.js'

const isUri = (scheme: string) => (s: string) => s.startsWith(`${scheme}:`)

test('remapUris rewrites only URI-looking strings, deeply', () => {
  const input = {
    sessionId: 's1',
    textDocument: { uri: 'vsls:/Fixture.lean' },
    params: { textDocument: { uri: 'vsls:/Fixture.lean' }, position: { line: 3, character: 2 } },
    nested: [{ uri: 'vsls:/A.lean' }, 'not-a-uri', 42],
  }
  const out = remapUris(input, s => s.replace('vsls:', 'file:'), isUri('vsls')) as typeof input
  assert.equal(out.textDocument.uri, 'file:/Fixture.lean')
  assert.equal(out.params.textDocument.uri, 'file:/Fixture.lean')
  assert.equal(out.params.position.line, 3)
  assert.equal((out.nested[0] as { uri: string }).uri, 'file:/A.lean')
  assert.equal(out.nested[1], 'not-a-uri')
  assert.equal(out.nested[2], 42)
})

test('remapUris rewrites URI-looking object keys (e.g. WorkspaceEdit.changes)', () => {
  const edit = {
    changes: {
      'vsls:/A.lean': [{ range: {}, newText: 'x' }],
      'vsls:/B.lean': [{ range: {}, newText: 'y' }],
    },
  }
  const out = remapUris(edit, s => s.replace('vsls:', 'file:'), isUri('vsls')) as {
    changes: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(out.changes).sort(), ['file:/A.lean', 'file:/B.lean'])
})

test('translating host channel maps request params in and results out', async () => {
  const [hostInner, guest] = createLoopbackPair()
  const host = makeUriTranslatingHostChannel(hostInner, {
    incoming: s => s.replace('vsls:', 'file:'),
    outgoing: s => s.replace('file:', 'vsls:'),
  })

  // Host handler echoes the uri it actually received (should be file:).
  let seenByHost = ''
  host.onRequest('echo', async (params: any) => {
    seenByHost = params.textDocument.uri
    return { resolved: { uri: 'file:/host/result.lean' } }
  })

  const result = (await guest.request('echo', { textDocument: { uri: 'vsls:/g.lean' } })) as {
    resolved: { uri: string }
  }

  assert.equal(seenByHost, 'file:/g.lean', 'host should receive a translated file: uri')
  assert.equal(result.resolved.uri, 'vsls:/host/result.lean', 'result uri should be translated back to vsls:')
})

test('translating host channel maps outgoing notification uris host->guest', async () => {
  const [hostInner, guest] = createLoopbackPair()
  const host = makeUriTranslatingHostChannel(hostInner, {
    incoming: s => s.replace('vsls:', 'file:'),
    outgoing: s => s.replace('file:', 'vsls:'),
  })

  const received: any[] = []
  guest.onNotify('server/notification', p => received.push(p))
  host.notify('server/notification', { method: '$/lean/fileProgress', params: { textDocument: { uri: 'file:/g.lean' } } })
  await new Promise(r => setTimeout(r, 20))

  assert.equal(received[0].params.textDocument.uri, 'vsls:/g.lean')
})
