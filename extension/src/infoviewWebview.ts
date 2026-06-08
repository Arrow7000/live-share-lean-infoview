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

/**
 * The infoview colors goals via theme colors that the `lean4` extension
 * contributes (`lean4.infoView.hypothesisName`, etc.). VS Code only injects
 * those as `--vscode-lean4-infoView.*` CSS variables when lean4's contribution
 * is active, which is unreliable on a Live Share guest (restricted workspace /
 * lean4 not fully enabled) — so hypothesis names render white. We define the
 * variables ourselves (escaped dot, as the infoview CSS references them),
 * scoped by VS Code's theme-kind body class, using lean4's documented defaults.
 * References to other theme colors reuse the standard `--vscode-*` variables.
 */
const LEAN_INFOVIEW_COLORS = `
  body.vscode-light {
    --vscode-lean4-infoView\\.hypothesisName: #cc7a00;
    --vscode-lean4-infoView\\.inaccessibleHypothesisName: var(--vscode-editor-foreground);
    --vscode-lean4-infoView\\.goalCount: #367cb6;
    --vscode-lean4-infoView\\.turnstile: #367cb6;
    --vscode-lean4-infoView\\.caseLabel: #1f7a1f;
  }
  body.vscode-dark {
    --vscode-lean4-infoView\\.hypothesisName: #ffcc00;
    --vscode-lean4-infoView\\.inaccessibleHypothesisName: var(--vscode-editor-foreground);
    --vscode-lean4-infoView\\.goalCount: #569cd6;
    --vscode-lean4-infoView\\.turnstile: #569cd6;
    --vscode-lean4-infoView\\.caseLabel: #a1df90;
  }
  body.vscode-high-contrast {
    --vscode-lean4-infoView\\.hypothesisName: var(--vscode-foreground);
    --vscode-lean4-infoView\\.inaccessibleHypothesisName: var(--vscode-editor-foreground);
    --vscode-lean4-infoView\\.goalCount: var(--vscode-terminal-ansiBlue);
    --vscode-lean4-infoView\\.turnstile: var(--vscode-terminal-ansiBlue);
    --vscode-lean4-infoView\\.caseLabel: var(--vscode-terminal-ansiGreen);
  }
  body.vscode-high-contrast-light {
    --vscode-lean4-infoView\\.hypothesisName: var(--vscode-foreground);
    --vscode-lean4-infoView\\.inaccessibleHypothesisName: var(--vscode-editor-foreground);
    --vscode-lean4-infoView\\.goalCount: var(--vscode-terminal-ansiBlue);
    --vscode-lean4-infoView\\.turnstile: var(--vscode-terminal-ansiBlue);
    --vscode-lean4-infoView\\.caseLabel: var(--vscode-terminal-ansiGreen);
  }
`

function htmlContent(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const infoviewJs = (f: string) => uri(webview, mediaRoot, 'infoview', f)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-type" content="text/html;charset=utf-8" />
  <title>Lean Infoview</title>
  <link rel="stylesheet" href="${infoviewJs('index.css')}" />
  <style>${LEAN_INFOVIEW_COLORS}</style>
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
