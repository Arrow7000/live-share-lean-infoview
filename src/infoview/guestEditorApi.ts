/**
 * Guest-side implementation of the infoview's `EditorRpcApi`, backed by a
 * `GuestEditorClient` (which talks to the host's Lean server over a
 * `BridgeChannel`).
 *
 * This is the heart of the guest: it answers everything the infoview webview
 * asks of its "editor". Lean-relevant calls (rpc session, client request,
 * client notification, server-notification subscriptions) go over the bridge;
 * editor actions (insert text, apply edit, etc.) are delegated to optional host
 * actions supplied by the VS Code extension. It is framework-agnostic and fully
 * unit-testable without VS Code.
 */

import type { GuestEditorClient } from '../bridge/guestEditorClient.js'
import type { Disposable } from '../bridge/types.js'
import type { EditorRpcApi, InfoviewConfig, TextInsertKind, TextDocumentPositionParams } from './api.js'

/** Editor-side actions that require touching the real editor (provided by the extension). */
export interface EditorHostActions {
  saveConfig(config: InfoviewConfig): Promise<void>
  copyToClipboard(text: string): Promise<void>
  insertText(text: string, kind: TextInsertKind, pos?: TextDocumentPositionParams): Promise<void>
  applyEdit(edit: unknown): Promise<void>
  showDocument(show: unknown): Promise<void>
  restartFile(uri: string): Promise<void>
}

export interface GuestEditorApiOptions {
  /** Forward a received server notification to the infoview (`gotServerNotification`). */
  onServerNotification: (method: string, params: unknown) => void
  /** Real editor actions; any omitted default to no-ops. */
  host?: Partial<EditorHostActions>
  log?: (line: string) => void
}

export interface GuestEditorApi extends EditorRpcApi {
  dispose(): void
}

export function createGuestEditorApi(guest: GuestEditorClient, options: GuestEditorApiOptions): GuestEditorApi {
  const log = options.log ?? (() => {})
  const host = options.host ?? {}

  // In-flight client requests, addressed by a fresh id (for the start/await split).
  let nextRequestId = 0
  const pending = new Map<number, { promise: Promise<unknown>; abort: AbortController }>()

  // Ref-counted server-notification subscriptions and their local routers.
  const serverSubs = new Map<string, { count: number; disposable: Disposable }>()

  const api: GuestEditorApi = {
    async startClientRequest(uri: string, method: string, params: unknown): Promise<number> {
      const id = nextRequestId++
      const abort = new AbortController()
      const promise = guest.sendClientRequest(uri, method, params)
      pending.set(id, { promise, abort })
      return id
    },
    async awaitClientRequest(id: number): Promise<unknown> {
      const entry = pending.get(id)
      if (!entry) throw new Error(`no pending client request ${id}`)
      try {
        return await entry.promise
      } finally {
        pending.delete(id)
      }
    },
    async cancelClientRequest(id: number): Promise<void> {
      // Best-effort: drop the pending entry. Forwarding `$/cancelRequest` over
      // the bridge is a future refinement (see hardening notes).
      const entry = pending.get(id)
      if (entry) {
        entry.abort.abort()
        pending.delete(id)
      }
    },

    createRpcSession(uri: string): Promise<string> {
      return guest.createRpcSession(uri)
    },
    closeRpcSession(sessionId: string): Promise<void> {
      return guest.closeRpcSession(sessionId)
    },

    async sendClientNotification(uri: string, method: string, params: unknown): Promise<void> {
      await guest.sendClientNotification(uri, method, params)
    },

    async subscribeServerNotifications(method: string): Promise<void> {
      const existing = serverSubs.get(method)
      if (existing) {
        existing.count += 1
        return
      }
      const disposable = guest.onServerNotification(method, params => options.onServerNotification(method, params))
      await guest.subscribeServerNotifications(method)
      serverSubs.set(method, { count: 1, disposable })
      log(`subscribed to server notification '${method}'`)
    },
    async unsubscribeServerNotifications(method: string): Promise<void> {
      const existing = serverSubs.get(method)
      if (!existing) return
      existing.count -= 1
      if (existing.count <= 0) {
        existing.disposable.dispose()
        serverSubs.delete(method)
        await guest.unsubscribeServerNotifications(method)
      }
    },

    // Client-notification echoes aren't needed for goal display yet.
    async subscribeClientNotifications(_method: string): Promise<void> {},
    async unsubscribeClientNotifications(_method: string): Promise<void> {},

    // Editor actions: delegate to host actions when provided, else no-op.
    async saveConfig(config: InfoviewConfig): Promise<unknown> {
      await host.saveConfig?.(config)
      return undefined
    },
    async copyToClipboard(text: string): Promise<void> {
      await host.copyToClipboard?.(text)
    },
    async insertText(text: string, kind: TextInsertKind, pos?: TextDocumentPositionParams): Promise<void> {
      await host.insertText?.(text, kind, pos)
    },
    async applyEdit(edit: unknown): Promise<void> {
      await host.applyEdit?.(edit)
    },
    async showDocument(show: unknown): Promise<void> {
      await host.showDocument?.(show)
    },
    async restartFile(uri: string): Promise<void> {
      await host.restartFile?.(uri)
    },

    dispose() {
      for (const { disposable } of serverSubs.values()) disposable.dispose()
      serverSubs.clear()
      pending.clear()
    },
  }
  return api
}
