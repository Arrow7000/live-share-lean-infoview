import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

/**
 * In-Electron render smoke test. Activates the extension, asks it to render the
 * captured golden payload in the real @leanprover/infoview webview, and asserts
 * the goal was actually drawn into the DOM (via the infoview's getInfoviewHtml).
 */
export async function run(): Promise<void> {
  const goldenPath = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'golden', 'goldenGoals.json')
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))

  const ext = vscode.extensions.getExtension('live-share-lean-infoview.lean4-live-share-infoview')
  assert.ok(ext, 'extension not found in test host')
  await ext!.activate()

  const html = (await vscode.commands.executeCommand('leanLiveShare._renderGoldenForTest', golden)) as string

  assert.ok(typeof html === 'string' && html.length > 0, 'infoview returned empty HTML')
  assert.ok(
    !/Waiting for Lean server/.test(html),
    'infoview is still in the "waiting for server" state:\n' + html.slice(0, 800),
  )
  assert.ok(
    /∧|⊢/.test(html),
    'goal was not rendered (no ∧ / ⊢ in DOM). First 1500 chars:\n' + html.slice(0, 1500),
  )

  console.log('render smoke test: goal rendered OK; html length =', html.length)
}
