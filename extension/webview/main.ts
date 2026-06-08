/**
 * Webview bootstrap (loaded as a classic script). Mirrors vscode-lean4's
 * webview entry: set up the postMessage RPC, build the EditorApi proxy, and
 * load the real @leanprover/infoview via its loader + importmap.
 */

import { loadRenderInfoview } from '@leanprover/infoview/loader'
import type { EditorApi, EditorRpcApi, InfoviewApi } from '../../src/infoview/api.js'
import { editorApiOfRpc, Rpc } from '../../src/infoview/rpc.js'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void }

const vscodeApi = acquireVsCodeApi()

const rpc = new Rpc((m: unknown) => vscodeApi.postMessage(m))
window.addEventListener('message', e => rpc.messageReceived((e as MessageEvent).data))
const editorApi: EditorApi = editorApiOfRpc(rpc.getApi<EditorRpcApi>())

const div: HTMLElement | null = document.querySelector('#react_root')
const script = document.currentScript as HTMLScriptElement | null

function post(kind: string, detail?: unknown) {
  // Surface webview-side lifecycle/errors to the extension host log.
  vscodeApi.postMessage({ kind: 'webviewLog', detail: { event: kind, detail } })
}

window.addEventListener('error', e => post('error', { message: e.message, stack: (e.error as Error)?.stack }))
window.addEventListener('unhandledrejection', e => post('unhandledrejection', { reason: String(e.reason) }))

if (div && script) {
  const imports = {
    '@leanprover/infoview': script.getAttribute('data-importmap-leanprover-infoview')!,
    react: script.getAttribute('data-importmap-react')!,
    'react/jsx-runtime': script.getAttribute('data-importmap-react-jsx-runtime')!,
    'react-dom': script.getAttribute('data-importmap-react-dom')!,
  }
  post('loading', imports)
  loadRenderInfoview(imports, [editorApi, div], async (api: InfoviewApi) => {
    rpc.register(api)
    post('rendered')
  })
} else {
  post('bootstrap-failed', { hasDiv: !!div, hasScript: !!script })
}
