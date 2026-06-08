import * as vscode from 'vscode'
import * as vsls from 'vsls'
import { startGuestRole } from './guestRole.js'
import { startHostRole } from './hostRole.js'
import { createInfoviewPanel, type InfoviewHost } from './infoviewWebview.js'
import { createReplayEditorApi, type GoldenGoals } from './replayEditor.js'

let output: vscode.OutputChannel
const log = (line: string) => output?.appendLine(`[${new Date().toISOString()}] ${line}`)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Lean Live Share')
  context.subscriptions.push(output)
  log('activated')

  void setupLiveShare(context).catch(e => log(`Live Share setup failed: ${describe(e)}`))

  context.subscriptions.push(
    vscode.commands.registerCommand('leanLiveShare.showLog', () => output.show(true)),
    vscode.commands.registerCommand('leanLiveShare.openInfoview', async () => {
      vscode.window.showInformationMessage(
        'Lean Live Share: the guest infoview opens automatically when you join a session as a guest. See the "Lean Live Share" output channel for status.',
      )
      output.show(true)
    }),
    // Hidden command used by the @vscode/test-electron render smoke test. Given a
    // captured golden payload, renders it in the real infoview webview and returns
    // the resulting HTML so the test can assert the goal was drawn.
    vscode.commands.registerCommand('leanLiveShare._renderGoldenForTest', async (golden: GoldenGoals) => {
      const editorApi = createReplayEditorApi(golden)
      const host: InfoviewHost = createInfoviewPanel(context, editorApi, log, {
        title: 'Lean Infoview (render test)',
        preserveFocus: false,
      })
      try {
        await host.infoview.serverRestarted(golden.initializeResult as never)
        await host.infoview.initialize(golden.location as never)

        const deadline = Date.now() + 30_000
        let html = ''
        while (Date.now() < deadline) {
          html = await host.infoview.getInfoviewHtml()
          if (/∧|⊢|hp\b/.test(html)) break
          await sleep(250)
        }
        log(`render test: html length ${html.length}`)
        return html
      } finally {
        host.dispose()
      }
    }),
  )
}

/** Watch the Live Share session and (re)wire the host or guest role on changes. */
async function setupLiveShare(context: vscode.ExtensionContext) {
  const api = await vsls.getApi(context.extension?.id ?? 'live-share-lean-infoview.lean4-live-share-infoview')
  if (!api) {
    log('Live Share extension not installed/available; guest infoview is inactive.')
    return
  }
  log('acquired Live Share API.')

  let roleSession: vscode.Disposable | undefined
  let currentRole: vsls.Role = vsls.Role.None

  const applyRole = async (role: vsls.Role) => {
    if (role === currentRole) return
    log(`session role: ${vsls.Role[currentRole]} -> ${vsls.Role[role]}`)
    currentRole = role
    roleSession?.dispose()
    roleSession = undefined
    try {
      if (role === vsls.Role.Host) roleSession = await startHostRole(api, log)
      else if (role === vsls.Role.Guest) roleSession = await startGuestRole(context, api, log)
    } catch (e) {
      log(`failed to start ${vsls.Role[role]} role: ${describe(e)}`)
    }
  }

  context.subscriptions.push(
    api.onDidChangeSession(e => void applyRole(e.session.role)),
    { dispose: () => roleSession?.dispose() },
  )
  await applyRole(api.session.role)
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

export function deactivate() {}
