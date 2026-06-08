/**
 * Minimal local copies of the Lean custom-RPC wire types we depend on.
 *
 * These mirror `@leanprover/infoview-api`'s `lspTypes.ts` / `rpcApi.ts`, but we
 * keep our own copy so the headless spike has zero dependency on the infoview
 * packages. The method-name strings and param/result shapes were verified
 * against `reference/vscode-lean4` (see the project README "Findings" section).
 */

import type { Position, Range, TextDocumentPositionParams } from 'vscode-languageserver-protocol'

/** Wire method strings sent as plain LSP requests/notifications. [CONFIRMED] */
export const LeanRpcMethod = {
  connect: '$/lean/rpc/connect',
  call: '$/lean/rpc/call',
  keepAlive: '$/lean/rpc/keepAlive',
  release: '$/lean/rpc/release',
} as const

/** Notification method strings. [CONFIRMED] */
export const LeanNotification = {
  fileProgress: '$/lean/fileProgress',
  publishDiagnostics: 'textDocument/publishDiagnostics',
} as const

/** Fully-qualified RPC method names passed *inside* `$/lean/rpc/call`. [CONFIRMED] */
export const LeanWidgetRpc = {
  getInteractiveGoals: 'Lean.Widget.getInteractiveGoals',
  getInteractiveTermGoal: 'Lean.Widget.getInteractiveTermGoal',
  getInteractiveDiagnostics: 'Lean.Widget.getInteractiveDiagnostics',
  getWidgets: 'Lean.Widget.getWidgets',
  getWidgetSource: 'Lean.Widget.getWidgetSource',
} as const

export interface RpcConnectParams {
  uri: string
}
export interface RpcConnected {
  sessionId: string
}
export interface RpcKeepAliveParams {
  uri: string
  sessionId: string
}
export interface RpcCallParams extends TextDocumentPositionParams {
  sessionId: string
  method: string
  params: unknown
}
export interface RpcReleaseParams {
  uri: string
  sessionId: string
  refs: unknown[]
}

/** A string with substrings decorated by objects of type `T`. */
export type TaggedText<T> = { text: string } | { append: TaggedText<T>[] } | { tag: [T, TaggedText<T>] }

export type CodeWithInfos = TaggedText<unknown>

export interface InteractiveHypothesisBundle {
  names: string[]
  fvarIds?: string[]
  type: CodeWithInfos
  val?: CodeWithInfos
  isInstance?: boolean
  isType?: boolean
}

export interface InteractiveGoal {
  hyps: InteractiveHypothesisBundle[]
  type: CodeWithInfos
  userName?: string
  goalPrefix?: string
  mvarId?: string
}

export interface InteractiveGoals {
  goals: InteractiveGoal[]
}

export interface InteractiveTermGoal {
  hyps: InteractiveHypothesisBundle[]
  type: CodeWithInfos
  range?: Range
}

/** Flatten a `TaggedText` / `CodeWithInfos` into its plain string content. */
export function flattenTaggedText(t: TaggedText<unknown> | undefined | null): string {
  if (t === undefined || t === null) return ''
  if ('text' in t) return t.text
  if ('append' in t) return t.append.map(flattenTaggedText).join('')
  if ('tag' in t) return flattenTaggedText(t.tag[1])
  return ''
}

/** Render a single interactive goal as the infoview roughly would, e.g.
 * `p q : Prop\nhp : p\n⊢ p ∧ q`. Used for human-readable logging and assertions. */
export function renderGoal(goal: InteractiveGoal): string {
  const lines: string[] = []
  for (const h of goal.hyps) {
    const names = h.names.join(' ')
    const type = flattenTaggedText(h.type)
    lines.push(`${names} : ${type}`)
  }
  const prefix = goal.goalPrefix ?? '⊢ '
  lines.push(`${prefix}${flattenTaggedText(goal.type)}`)
  const name = goal.userName !== undefined ? `case ${goal.userName}\n` : ''
  return name + lines.join('\n')
}

export type { Position, TextDocumentPositionParams }
