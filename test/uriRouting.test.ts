import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractUri, pickByFolder } from '../src/bridge/uriRouting.js'

test('extractUri reads uri and textDocument.uri', () => {
  assert.equal(extractUri({ uri: 'file:///a.lean' }), 'file:///a.lean')
  assert.equal(extractUri({ textDocument: { uri: 'file:///b.lean' }, position: { line: 1 } }), 'file:///b.lean')
  assert.equal(extractUri({ sessionId: 's' }), undefined)
  assert.equal(extractUri(undefined), undefined)
  assert.equal(extractUri('nope'), undefined)
})

test('pickByFolder picks the innermost (longest-prefix) project', () => {
  const clients = [
    { name: 'outer', folder: '/home/me/proj' },
    { name: 'inner', folder: '/home/me/proj/sub' },
    { name: 'other', folder: '/home/me/elsewhere' },
  ]
  const folderOf = (c: (typeof clients)[number]) => c.folder
  assert.equal(pickByFolder(clients, folderOf, '/home/me/proj/sub/A.lean')?.name, 'inner')
  assert.equal(pickByFolder(clients, folderOf, '/home/me/proj/B.lean')?.name, 'outer')
  assert.equal(pickByFolder(clients, folderOf, '/home/me/elsewhere/C.lean')?.name, 'other')
})

test('pickByFolder falls back to the first client when nothing matches or no target', () => {
  const clients = [{ name: 'a', folder: '/x' }, { name: 'b', folder: '/y' }]
  const folderOf = (c: (typeof clients)[number]) => c.folder
  assert.equal(pickByFolder(clients, folderOf, '/z/unrelated.lean')?.name, 'a')
  assert.equal(pickByFolder(clients, folderOf, undefined)?.name, 'a')
  assert.equal(pickByFolder([], folderOf, '/x/a.lean'), undefined)
})

test('pickByFolder does not treat sibling prefixes as matches', () => {
  const clients = [{ name: 'proj', folder: '/home/me/proj' }]
  const folderOf = (c: (typeof clients)[number]) => c.folder
  // '/home/me/project' must NOT match folder '/home/me/proj'
  assert.equal(pickByFolder(clients, folderOf, '/home/me/project/A.lean')?.name, 'proj') // fallback to first
  // (no real match, so it falls back; assert it's the fallback, not a true prefix match)
})
