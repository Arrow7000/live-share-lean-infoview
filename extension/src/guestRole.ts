import * as vscode from 'vscode'
import type * as vsls from 'vsls'
import { GuestEditorClient } from '../../src/bridge/guestEditorClient.js'
import { connectWebSocketGuest, type WebSocketChannel } from '../../src/bridge/webSocketChannel.js'
import type { Location } from '../../src/infoview/api.js'
import { createGuestEditorApi } from '../../src/infoview/guestEditorApi.js'
import { createInfoviewPanel, type InfoviewHost } from './infoviewWebview.js'
import { portForSession } from './protocol.js'

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
  const sessionId = api.session.id
  if (!sessionId) {
    log('GUEST: no session id yet; cannot connect to the bridge.')
    return { dispose: () => {} }
  }
  const port = portForSession(sessionId)
  const url = `ws://127.0.0.1:${port}`
  log(`GUEST: connecting to bridge at ${url} (derived from session id)...`)

  // Connect to the host's WebSocket bridge (shared via shareServer; on the same
  // machine this reaches the host's server directly). Retry while the host's
  // server / Live Share tunnel comes up.
  let channel: WebSocketChannel | undefined
  let disposed = false
  for (let i = 0; i < 60 && !disposed; i++) {
    try {
      channel = await connectWebSocketGuest(url)
      break
    } catch {
      await sleep(1000)
    }
  }
  if (!channel) {
    log(`GUEST: could not connect to the bridge at ${url}. Is the host in a session with this extension?`)
    return { dispose: () => {} }
  }
  log('GUEST: connected to bridge.')

  const guestClient = new GuestEditorClient(channel)

  let infoviewHost: InfoviewHost | undefined
  const editorApi = createGuestEditorApi(guestClient, {
    onServerNotification: (method, params) => void infoviewHost?.infoview.gotServerNotification(method, params),
    host: {
      copyToClipboard: async (text: string) => void vscode.env.clipboard.writeText(text),
    },
    log,
  })

  // Open the panel immediately so the user sees the infoview (it shows
  // "Waiting for Lean server..." until the bridge becomes available).
  infoviewHost = createInfoviewPanel(context, editorApi, log, { title: 'Lean Infoview (Live Share guest)' })

  // Drive the cursor → infoview loop from the guest's selection (debounced).
  let live = false
  let initialized = false
  let timer: NodeJS.Timeout | undefined
  const pushCursor = (editor: vscode.TextEditor | undefined) => {
    if (!live || !editor || !isLeanDoc(editor.document)) return
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

  // Start the infoview session: fetch the server's initialize result (retrying,
  // since the host's Lean server may still be starting), tell the infoview the
  // server is up, then begin driving the cursor.
  const goLive = async () => {
    if (live) return
    let init
    for (let i = 0; i < 60 && !disposed; i++) {
      try {
        init = await guestClient.getServerInitializeResult()
      } catch (e) {
        log(`GUEST: getServerInitializeResult failed (attempt ${i}): ${e instanceof Error ? e.message : String(e)}`)
      }
      if (init && (init.capabilities as { experimental?: unknown } | undefined)?.experimental !== undefined) break
      if (init) log('GUEST: host has no server capabilities yet (Lean server still starting?); retrying...')
      init = undefined
      await sleep(1000)
    }
    if (disposed) return
    live = true
    if (init) {
      await infoviewHost!.infoview.serverRestarted(init as never)
      log(`GUEST: serverRestarted (version ${init.serverInfo?.version}). Move the cursor into a proof.`)
    } else {
      log('GUEST: gave up waiting for the host server initialize result; the infoview will stay in "waiting".')
    }
    pushCursor(vscode.window.activeTextEditor)
  }

  const subs: vscode.Disposable[] = [
    vscode.window.onDidChangeTextEditorSelection(e => pushCursor(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => pushCursor(editor)),
  ]

  void goLive()

  return {
    dispose: () => {
      disposed = true
      clearTimeout(timer)
      for (const s of subs) s.dispose()
      editorApi.dispose()
      guestClient.dispose()
      channel.dispose()
      infoviewHost?.dispose()
      log('GUEST: infoview session disposed.')
    },
  }
}
