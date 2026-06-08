import * as vscode from 'vscode'
import type { EditorRpcApi, InfoviewApi } from '../../src/infoview/api.js'
import { Rpc } from '../../src/infoview/rpc.js'

export interface InfoviewHost {
  panel: vscode.WebviewPanel
  /** Proxy used to drive the infoview (initialize/serverRestarted/changedCursorLocation/...). */
  infoview: InfoviewApi
  dispose(): void
}

/**
 * Create the infoview webview panel, wire the postMessage RPC so the panel's
 * `EditorApi` calls are answered by `editorApi`, and return a proxy to drive the
 * infoview. Mirrors vscode-lean4's host-side setup (it does not depend on how
 * `editorApi` is implemented, so it works for both the real guest and tests).
 */
export function createInfoviewPanel(
  context: vscode.ExtensionContext,
  editorApi: EditorRpcApi,
  log: (line: string) => void,
  options: { title?: string; column?: vscode.ViewColumn; preserveFocus?: boolean } = {},
): InfoviewHost {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media')
  const panel = vscode.window.createWebviewPanel(
    'leanLiveShareInfoview',
    options.title ?? 'Lean Infoview (Live Share)',
    { viewColumn: options.column ?? vscode.ViewColumn.Beside, preserveFocus: options.preserveFocus ?? true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
  )

  const rpc = new Rpc((m: unknown) => void panel.webview.postMessage(m))
  panel.webview.onDidReceiveMessage((m: any) => {
    if (m && m.kind === 'webviewLog') {
      log(`[webview] ${JSON.stringify(m.detail)}`)
      return
    }
    rpc.messageReceived(m)
  })
  rpc.register(editorApi)
  const infoview = rpc.getApi<InfoviewApi>()

  panel.webview.html = htmlContent(panel.webview, mediaRoot)
  log(`infoview panel created`)

  return {
    panel,
    infoview,
    dispose: () => panel.dispose(),
  }
}

function uri(webview: vscode.Webview, mediaRoot: vscode.Uri, ...segs: string[]): string {
  return webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, ...segs)).toString()
}

function htmlContent(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const infoviewJs = (f: string) => uri(webview, mediaRoot, 'infoview', f)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-type" content="text/html;charset=utf-8" />
  <title>Lean Infoview</title>
  <link rel="stylesheet" href="${infoviewJs('index.css')}" />
</head>
<body>
  <div id="react_root"></div>
  <script
    data-importmap-leanprover-infoview="${infoviewJs('index.production.min.js')}"
    data-importmap-react="${infoviewJs('react.production.min.js')}"
    data-importmap-react-jsx-runtime="${infoviewJs('react-jsx-runtime.production.min.js')}"
    data-importmap-react-dom="${infoviewJs('react-dom.production.min.js')}"
    src="${uri(webview, mediaRoot, 'webview.js')}"></script>
</body>
</html>`
}
