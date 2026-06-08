import * as vscode from 'vscode'
import type * as vsls from 'vsls'
import { GuestEditorClient } from '../../src/bridge/guestEditorClient.js'
import { createGuestChannel } from '../../src/bridge/liveShareChannel.js'
import type { Location } from '../../src/infoview/api.js'
import { createGuestEditorApi } from '../../src/infoview/guestEditorApi.js'
import { createInfoviewPanel, type InfoviewHost } from './infoviewWebview.js'
import { SERVICE_NAME } from './protocol.js'

const LEAN_LANGUAGES = new Set(['lean', 'lean4'])
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function isLeanDoc(doc: vscode.TextDocument): boolean {
  return LEAN_LANGUAGES.has(doc.languageId)
}

function locationOf(editor: vscode.TextEditor): Location {
  const sel = editor.selection
  const pos = { line: sel.active.line, character: sel.active.character }
  return { uri: editor.document.uri.toString(), range: { start: pos, end: pos } }
}

/**
 * Wire the guest side: connect to the host's shared service, open the infoview
 * webview backed by the bridge, and drive it from the guest's cursor in the
 * shared Lean document.
 */
export async function startGuestRole(
  context: vscode.ExtensionContext,
  api: vsls.LiveShare,
  log: (s: string) => void,
): Promise<vscode.Disposable> {
  log(`GUEST: getting shared service '${SERVICE_NAME}'...`)
  const proxy = await api.getSharedService(SERVICE_NAME)
  if (!proxy) {
    log('GUEST: getSharedService returned null — the host may not be sharing the bridge.')
    return { dispose: () => {} }
  }

  // Wait for the host to actually be sharing.
  for (let i = 0; i < 60 && !proxy.isServiceAvailable; i++) await sleep(250)
  if (!proxy.isServiceAvailable) {
    log('GUEST: bridge service not available (is the host in a session with this extension?).')
    return { dispose: () => {} }
  }
  log('GUEST: bridge service available.')

  const guestClient = new GuestEditorClient(createGuestChannel(proxy))

  let infoviewHost: InfoviewHost | undefined
  const editorApi = createGuestEditorApi(guestClient, {
    onServerNotification: (method, params) => void infoviewHost?.infoview.gotServerNotification(method, params),
    host: {
      copyToClipboard: async (text: string) => void vscode.env.clipboard.writeText(text),
    },
    log,
  })

  infoviewHost = createInfoviewPanel(context, editorApi, log, { title: 'Lean Infoview (Live Share guest)' })

  // Tell the infoview the server is up so it leaves the "waiting" state.
  try {
    const init = await guestClient.getServerInitializeResult()
    if (init) {
      await infoviewHost.infoview.serverRestarted(init as never)
      log(`GUEST: serverRestarted (version ${init.serverInfo?.version}).`)
    } else {
      log('GUEST: host returned no initialize result; infoview may stay in "waiting" state.')
    }
  } catch (e) {
    log(`GUEST: failed to fetch server initialize result: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Drive the cursor → infoview loop from the guest's selection (debounced).
  let initialized = false
  let timer: NodeJS.Timeout | undefined
  const pushCursor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || !isLeanDoc(editor.document)) return
    const loc = locationOf(editor)
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!initialized) {
        initialized = true
        void infoviewHost?.infoview.initialize(loc)
        log(`GUEST: infoview initialized at ${loc.uri}:${loc.range.start.line}`)
      } else {
        void infoviewHost?.infoview.changedCursorLocation(loc)
      }
    }, 100)
  }

  pushCursor(vscode.window.activeTextEditor)
  const subs: vscode.Disposable[] = [
    vscode.window.onDidChangeTextEditorSelection(e => pushCursor(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => pushCursor(editor)),
  ]

  return {
    dispose: () => {
      clearTimeout(timer)
      for (const s of subs) s.dispose()
      editorApi.dispose()
      guestClient.dispose()
      infoviewHost?.dispose()
      log('GUEST: infoview session disposed.')
    },
  }
}
