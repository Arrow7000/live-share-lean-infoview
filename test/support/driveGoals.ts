import type { Position } from 'vscode-languageserver-protocol'
import type { GuestEditorClient } from '../../src/bridge/guestEditorClient.js'
import { type InteractiveGoals, LeanRpcMethod, LeanWidgetRpc } from '../../src/lean-rpc/leanRpcTypes.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Drive a full "show goals" flow through a guest client exactly as the infoview
 * does: open an RPC session, then issue `$/lean/rpc/call` for
 * `Lean.Widget.getInteractiveGoals` at the position. Retries until a goal
 * appears (elaboration may still be settling) or the deadline passes.
 */
export async function driveGoalsThroughGuest(
  guest: GuestEditorClient,
  uri: string,
  position: Position,
  timeoutMs = 30_000,
): Promise<{ sessionId: string; goals: InteractiveGoals; latencyMs: number }> {
  const sessionId = await guest.createRpcSession(uri)
  const tdpp = { textDocument: { uri }, position }
  const callParams = {
    sessionId,
    method: LeanWidgetRpc.getInteractiveGoals,
    params: tdpp,
    textDocument: { uri },
    position,
  }

  let goals: InteractiveGoals | undefined
  let latencyMs = 0
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t0 = Date.now()
    goals = (await guest.sendClientRequest(uri, LeanRpcMethod.call, callParams)) as InteractiveGoals | undefined
    latencyMs = Date.now() - t0
    if (goals && goals.goals.length > 0) break
    await sleep(300)
  }
  if (!goals || goals.goals.length === 0) {
    throw new Error('no goals returned through the bridge before deadline')
  }
  return { sessionId, goals, latencyMs }
}
