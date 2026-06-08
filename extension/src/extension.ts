import * as vscode from 'vscode'
import { createInfoviewPanel, type InfoviewHost } from './infoviewWebview.js'
import { createReplayEditorApi, type GoldenGoals } from './replayEditor.js'

let output: vscode.OutputChannel
const log = (line: string) => output?.appendLine(`[${new Date().toISOString()}] ${line}`)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Lean Live Share')
  context.subscriptions.push(output)
  log('activated')

  context.subscriptions.push(
    vscode.commands.registerCommand('leanLiveShare.showLog', () => output.show(true)),
    vscode.commands.registerCommand('leanLiveShare.openInfoview', async () => {
      vscode.window.showInformationMessage(
        'Lean Live Share: the guest infoview activates automatically when you join a Live Share session as a guest (wiring lands in M4).',
      )
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

export function deactivate() {}
