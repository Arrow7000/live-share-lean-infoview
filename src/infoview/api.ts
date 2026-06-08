/**
 * Minimal local copies of the infoview's `EditorApi` / `InfoviewApi` interfaces
 * (from `@leanprover/infoview-api`). We keep our own copy so the framework-
 * agnostic glue here and the headless tests don't depend on the infoview
 * packages; the real webview bundle uses the genuine types. These are kept
 * structurally compatible (method names + JSON shapes) with upstream.
 */

import type {
  InitializeResult,
  Location,
  ShowDocumentParams,
  TextDocumentPositionParams,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol'

export type { Location, TextDocumentPositionParams }

export type TextInsertKind = 'here' | 'above'

export interface InfoviewConfig {
  allErrorsOnLine: boolean
  autoOpenShowsGoal: boolean
  debounceTime: number
  expectedTypeVisibility: 'Expanded by default' | 'Collapsed by default' | 'Hidden'
  showGoalNames: boolean
  emphasizeFirstGoal: boolean
  reverseTacticState: boolean
  hideTypeAssumptions: boolean
  hideInstanceAssumptions: boolean
  hideInaccessibleAssumptions: boolean
  hideLetValues: boolean
  showTooltipOnHover: boolean
  messageOrder: 'Sort by proximity to text cursor' | 'Sort by message location'
}

export const defaultInfoviewConfig: InfoviewConfig = {
  allErrorsOnLine: true,
  autoOpenShowsGoal: true,
  debounceTime: 50,
  expectedTypeVisibility: 'Expanded by default',
  showGoalNames: true,
  emphasizeFirstGoal: false,
  reverseTacticState: false,
  hideTypeAssumptions: false,
  hideInstanceAssumptions: false,
  hideInaccessibleAssumptions: false,
  hideLetValues: false,
  showTooltipOnHover: true,
  messageOrder: 'Sort by proximity to text cursor',
}

export interface ClientRequestOptions {
  abortSignal?: AbortSignal
}

/** What the infoview webview calls on the hosting editor. */
export interface EditorApi {
  saveConfig(config: InfoviewConfig): Promise<unknown>
  sendClientRequest(uri: string, method: string, params: unknown, options?: ClientRequestOptions): Promise<unknown>
  sendClientNotification(uri: string, method: string, params: unknown): Promise<void>
  subscribeServerNotifications(method: string): Promise<void>
  unsubscribeServerNotifications(method: string): Promise<void>
  subscribeClientNotifications(method: string): Promise<void>
  unsubscribeClientNotifications(method: string): Promise<void>
  copyToClipboard(text: string): Promise<void>
  insertText(text: string, kind: TextInsertKind, pos?: TextDocumentPositionParams): Promise<void>
  applyEdit(te: WorkspaceEdit): Promise<void>
  showDocument(show: ShowDocumentParams): Promise<void>
  restartFile(uri: string): Promise<void>
  createRpcSession(uri: string): Promise<string>
  closeRpcSession(sessionId: string): Promise<void>
}

/**
 * Serializable form of `EditorApi` used over the webview<->host postMessage
 * boundary: `sendClientRequest` (which carries an `AbortSignal`) is split into
 * start/await/cancel so cancellation can cross the wire.
 */
export type EditorRpcApi = Omit<EditorApi, 'sendClientRequest'> & {
  startClientRequest(uri: string, method: string, params: unknown): Promise<number>
  awaitClientRequest(id: number): Promise<unknown>
  cancelClientRequest(id: number): Promise<void>
}

export interface ServerStoppedReason {
  message: string
  reason: string
}

/** What the hosting editor calls on the infoview webview. */
export interface InfoviewApi {
  initialize(loc: Location): Promise<void>
  gotServerNotification(method: string, params: unknown): Promise<void>
  sentClientNotification(method: string, params: unknown): Promise<void>
  serverRestarted(serverInitializeResult: InitializeResult): Promise<void>
  serverStopped(serverStoppedReason: ServerStoppedReason | undefined): Promise<void>
  changedCursorLocation(loc?: Location): Promise<void>
  changedInfoviewConfig(conf: InfoviewConfig): Promise<void>
  requestedAction(action: { kind: string }): Promise<void>
  clickedContextMenu(action: { entry: string; id: string }): Promise<void>
  runTestScript(javaScript: string): Promise<void>
  getInfoviewHtml(): Promise<string>
}
