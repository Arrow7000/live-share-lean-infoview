import * as vscode from 'vscode'
import type * as vsls from 'vsls'
import { GuestEditorClient } from '../../src/bridge/guestEditorClient.js'
import { connectWebSocketGuest, type WebSocketChannel } from '../../src/bridge/webSocketChannel.js'
import type { Location } from '../../src/infoview/api.js'
import { createGuestEditorApi } from '../../src/infoview/guestEditorApi.js'
import { LeanGutter } from './leanGutter.js'
import { createInfoviewPanel, type InfoviewHost } from './infoviewWebview.js'
import { portForSession } from './protocol.js'

const PUBLISH_DIAGNOSTICS = 'textDocument/publishDiagnostics'
const FILE_PROGRESS = '$/lean/fileProgress'

const LEAN_LANGUAGES = new Set(['lean', 'lean4'])
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function isLeanDoc(doc: vscode.TextDocument): boolean {
  // Accept by URI suffix too: on a Live Share guest the `vsls:` document may not
  // have the `lean4` language id assigned yet (the lean4 extension activates
  // lazily), but its path still ends in `.lean`.
  return LEAN_LANGUAGES.has(doc.languageId) || doc.uri.path.endsWith('.lean')
}

function locationOf(editor: vscode.TextEditor): Location {
  const sel = editor.selection
  const pos = { line: sel.active.line, character: sel.active.character }
  return { uri: editor.document.uri.toString(), range: { start: pos, end: pos } }
}

interface LspPosition {
  line: number
  character: number
}
interface LspRange {
  start: LspPosition
  end: LspPosition
}
function toRange(r: LspRange | undefined): vscode.Range | undefined {
  return r ? new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character) : undefined
}

export interface GuestRoleSession extends vscode.Disposable {
  /** Reopen the infoview panel (or reveal it) — backs the openInfoview command. */
  openInfoview?: () => void
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
): Promise<GuestRoleSession> {
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

  // Render Lean's editor gutter decorations on the guest from forwarded
  // notifications (independent of the infoview panel): processing (orange),
  // fatal error (red), goals-accomplished (blue ✓), and unsolved-goals (🛠).
  const gutter = new LeanGutter(context.extensionUri)
  guestClient.onServerNotification(PUBLISH_DIAGNOSTICS, params => gutter.updateDiagnostics(params as never))
  guestClient.onServerNotification(FILE_PROGRESS, params => gutter.updateProgress(params as never))

  let infoviewHost: InfoviewHost | undefined
  const editorApi = createGuestEditorApi(guestClient, {
    onServerNotification: (method, params) => void infoviewHost?.infoview.gotServerNotification(method, params),
    host: {
      copyToClipboard: async (text: string) => void vscode.env.clipboard.writeText(text),
      // "Go to source location of message" etc. The location URI is `vsls:` (we
      // translate it), which the guest can open directly.
      showDocument: async (show: unknown) => {
        const s = show as { uri: string; selection?: LspRange }
        try {
          const uri = vscode.Uri.parse(s.uri)
          const existing = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString())
          await vscode.window.showTextDocument(uri, {
            viewColumn: existing?.viewColumn,
            preserveFocus: false,
            selection: toRange(s.selection),
          })
        } catch (e) {
          log(`GUEST: showDocument failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
      // e.g. "Copy to comment". Inserts into the shared document (synced to the host).
      insertText: async (text: string, kind: string, pos?: { textDocument: { uri: string }; position: LspPosition }) => {
        try {
          const editor = pos
            ? vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === vscode.Uri.parse(pos.textDocument.uri).toString(),
              )
            : vscode.window.activeTextEditor
          if (!editor) return
          const at = pos ? new vscode.Position(pos.position.line, pos.position.character) : editor.selection.active
          if (kind === 'above') {
            const line = editor.document.lineAt(at.line)
            const indent = ' '.repeat(line.firstNonWhitespaceCharacterIndex)
            await editor.edit(b => b.insert(line.range.start, `${indent}${text.replace(/\n/g, '\n' + indent)}\n`))
          } else {
            await editor.edit(b => b.insert(at, text))
          }
        } catch (e) {
          log(`GUEST: insertText failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    },
    log,
  })

  // Track the latest Lean cursor location regardless of `live` (so clicks made
  // while we're still fetching the server's init result aren't lost), then flush
  // it to the infoview once we're live and on every subsequent move.
  let live = false
  let initialized = false
  let lastLoc: Location | undefined
  let timer: NodeJS.Timeout | undefined
  let serverInit: Awaited<ReturnType<typeof guestClient.getServerInitializeResult>>

  const sendLoc = (loc: Location) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!initialized) {
        initialized = true
        void infoviewHost?.infoview.initialize(loc)
        log(`GUEST: infoview initialized at ${loc.uri}:${loc.range.start.line}`)
      } else {
        void infoviewHost?.infoview.changedCursorLocation(loc)
      }
    }, 80)
  }

  const onCursor = (editor: vscode.TextEditor | undefined) => {
    if (!editor) return
    if (!isLeanDoc(editor.document)) return
    lastLoc = locationOf(editor)
    if (live) sendLoc(lastLoc)
  }

  // Pull the host's current diagnostics and replay them so the gutter checkmarks
  // and the infoview's messages are correct immediately on join / panel (re)open,
  // before the live subscription delivers the next update.
  const replayDiagnostics = async () => {
    let initial: Awaited<ReturnType<typeof guestClient.getDiagnostics>>
    try {
      initial = await guestClient.getDiagnostics()
    } catch {
      return
    }
    for (const d of initial) {
      gutter.updateDiagnostics(d as never)
      if (infoviewHost) void infoviewHost.infoview.gotServerNotification(PUBLISH_DIAGNOSTICS, d)
    }
  }

  // (Re)drive the current panel from scratch: announce the server, then push the
  // current Lean location (a fresh panel needs `initialize`, not a cursor change).
  const drivePanel = async () => {
    if (!infoviewHost || !live) return
    if (serverInit) await infoviewHost.infoview.serverRestarted(serverInit as never)
    initialized = false
    onCursor(vscode.window.activeTextEditor)
    if (lastLoc) sendLoc(lastLoc)
    void replayDiagnostics()
  }

  // Open the infoview panel (or reveal it if already open). Safe to call from the
  // `leanLiveShare.openInfoview` command after the user closes the panel.
  const openInfoview = () => {
    if (infoviewHost) {
      infoviewHost.panel.reveal(undefined, true)
      return
    }
    infoviewHost = createInfoviewPanel(context, editorApi, log, { title: 'Lean Infoview (Live Share guest)' })
    infoviewHost.panel.onDidDispose(() => {
      log('GUEST: infoview panel closed (reopen with "Lean Live Share: Open Guest Infoview").')
      infoviewHost = undefined
      initialized = false
    })
    void drivePanel()
  }

  // Start the session: fetch the server's initialize result (retrying, since the
  // host's Lean server may still be starting), then drive the panel.
  const goLive = async () => {
    if (live) return
    let init: typeof serverInit
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
    serverInit = init
    live = true
    if (init) log(`GUEST: server up (version ${init.serverInfo?.version}). Move the cursor into a proof.`)
    else log('GUEST: gave up waiting for the host server initialize result; the infoview will stay in "waiting".')
    // Forward diagnostics + file progress so the gutter decorations can render.
    // (Already-proven files only get a checkmark once diagnostics next update.)
    try {
      await guestClient.subscribeServerNotifications(PUBLISH_DIAGNOSTICS)
      await guestClient.subscribeServerNotifications(FILE_PROGRESS)
    } catch (e) {
      log(`GUEST: failed to subscribe to server notifications: ${e instanceof Error ? e.message : String(e)}`)
    }
    await drivePanel()
  }

  const subs: vscode.Disposable[] = [
    vscode.window.onDidChangeTextEditorSelection(e => onCursor(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => onCursor(editor)),
  ]

  // Open the panel up front (shows "Waiting..." until live), seed the cursor.
  openInfoview()
  onCursor(vscode.window.activeTextEditor)
  void goLive()

  return {
    openInfoview,
    dispose: () => {
      disposed = true
      clearTimeout(timer)
      for (const s of subs) s.dispose()
      gutter.dispose()
      editorApi.dispose()
      guestClient.dispose()
      channel.dispose()
      infoviewHost?.dispose()
      log('GUEST: infoview session disposed.')
    },
  }
}
