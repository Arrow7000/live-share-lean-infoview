import type { EditorRpcApi } from '../../src/infoview/api.js'
import { LeanRpcMethod, LeanWidgetRpc } from '../../src/lean-rpc/leanRpcTypes.js'

export interface GoldenGoals {
  uri: string
  position: { line: number; character: number }
  location: unknown
  initializeResult: { serverInfo: unknown; capabilities: unknown }
  goals: unknown
  termGoal: unknown
}

/**
 * An `EditorRpcApi` that serves a captured golden payload instead of talking to
 * a real server. Lets the webview render path be tested deterministically.
 */
export function createReplayEditorApi(golden: GoldenGoals): EditorRpcApi {
  const pending = new Map<number, Promise<unknown>>()
  let id = 0

  function respond(method: string, params: any): unknown {
    if (method === LeanRpcMethod.call) {
      const inner = params?.method as string
      switch (inner) {
        case LeanWidgetRpc.getInteractiveGoals:
          return golden.goals
        case LeanWidgetRpc.getInteractiveTermGoal:
          return golden.termGoal ?? null
        case LeanWidgetRpc.getInteractiveDiagnostics:
          return []
        case LeanWidgetRpc.getWidgets:
          return { widgets: [] }
        default:
          return null
      }
    }
    return null
  }

  return {
    async startClientRequest(_uri, method, params) {
      const i = id++
      pending.set(i, Promise.resolve(respond(method, params)))
      return i
    },
    async awaitClientRequest(i) {
      const p = pending.get(i)
      pending.delete(i)
      return p
    },
    async cancelClientRequest() {},
    async createRpcSession() {
      return 'golden-session'
    },
    async closeRpcSession() {},
    async sendClientNotification() {},
    async subscribeServerNotifications() {},
    async unsubscribeServerNotifications() {},
    async subscribeClientNotifications() {},
    async unsubscribeClientNotifications() {},
    async saveConfig() {
      return undefined
    },
    async copyToClipboard() {},
    async insertText() {},
    async applyEdit() {},
    async showDocument() {},
    async restartFile() {},
  }
}
