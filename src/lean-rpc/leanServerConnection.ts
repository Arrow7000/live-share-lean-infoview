/**
 * A thin, headless LSP + Lean-custom-RPC client over a spawned `lean --server`
 * (or `lake serve --`) process.
 *
 * This is the M1 spike code: it validates the entire custom-RPC story in total
 * isolation (no VS Code, no Live Share, no display). It is also written to be
 * reused by the host bridge in later milestones, since the host side does
 * exactly this: forward `$/lean/rpc/*` to a real Lean server and own keepalive.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import type {
  Diagnostic,
  InitializeParams,
  InitializeResult,
  Position,
} from 'vscode-languageserver-protocol'
import {
  type InteractiveGoals,
  type InteractiveTermGoal,
  LeanNotification,
  LeanRpcMethod,
  LeanWidgetRpc,
  type RpcCallParams,
  type RpcConnectParams,
  type RpcConnected,
  type RpcKeepAliveParams,
} from './leanRpcTypes.js'

const KEEPALIVE_PERIOD_MS = 10_000 // [CONFIRMED] from vscode-lean4 infoview.ts

export interface LeanServerOptions {
  /** Working directory; must contain `lean-toolchain` so elan picks the version. */
  cwd: string
  /** Launch command. Defaults to `lake` with `['serve', '--']` (production behaviour). */
  command?: string
  args?: string[]
  /** Extra LSP `initializationOptions`. Merged over `{ hasWidgets: true }`. */
  initializationOptions?: Record<string, unknown>
  /** Optional sink for server stderr / log lines, for debugging. */
  log?: (line: string) => void
}

export interface LeanFileProgressProcessingInfo {
  range: { start: Position; end: Position }
  kind?: number
}
interface LeanFileProgressParams {
  textDocument: { uri: string; version?: number }
  processing: LeanFileProgressProcessingInfo[]
}

/** Convert an absolute filesystem path to a `file://` URI. */
export function fileUri(absPath: string): string {
  return pathToFileURL(absPath).toString()
}

export class LeanServerConnection {
  private child!: ChildProcessWithoutNullStreams
  private connection!: MessageConnection
  private readonly log: (line: string) => void
  private initializeResult?: InitializeResult
  private readonly keepAliveTimers = new Map<string, NodeJS.Timeout>()
  private disposed = false

  constructor(private readonly options: LeanServerOptions) {
    this.log = options.log ?? (() => {})
  }

  get capabilities(): InitializeResult['capabilities'] | undefined {
    return this.initializeResult?.capabilities
  }

  get serverInfo(): InitializeResult['serverInfo'] | undefined {
    return this.initializeResult?.serverInfo
  }

  /** Spawn the server, wire JSON-RPC, and complete the LSP initialize handshake. */
  async start(): Promise<InitializeResult> {
    const command = this.options.command ?? 'lake'
    const args = this.options.args ?? ['serve', '--']
    this.log(`spawning: ${command} ${args.join(' ')} (cwd=${this.options.cwd})`)

    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.on('error', err => this.log(`server process error: ${err}`))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.log(`[stderr] ${line}`)
    })

    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    )

    // Respond to server->client requests so the handshake doesn't stall.
    this.connection.onRequest('workspace/configuration', (params: { items: unknown[] }) =>
      params.items.map(() => ({})),
    )
    this.connection.onRequest('client/registerCapability', () => null)
    this.connection.onRequest('client/unregisterCapability', () => null)
    this.connection.onRequest('window/workDoneProgress/create', () => null)
    this.connection.onRequest('window/showMessageRequest', () => null)

    this.connection.onError(err => this.log(`connection error: ${JSON.stringify(err)}`))
    this.connection.onClose(() => this.log('connection closed'))
    this.connection.listen()

    const initializeParams: InitializeParams = {
      processId: process.pid,
      rootUri: fileUri(this.options.cwd),
      workspaceFolders: [{ uri: fileUri(this.options.cwd), name: 'fixture' }],
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
        window: { workDoneProgress: true },
      },
      initializationOptions: { hasWidgets: true, ...this.options.initializationOptions },
    }

    this.initializeResult = (await this.connection.sendRequest(
      'initialize',
      initializeParams,
    )) as InitializeResult
    this.connection.sendNotification('initialized', {})
    this.log(`initialized; serverInfo=${JSON.stringify(this.initializeResult.serverInfo)}`)
    return this.initializeResult
  }

  /** Subscribe to a server notification (e.g. `$/lean/fileProgress`). */
  onNotification(method: string, handler: (params: unknown) => void) {
    return this.connection.onNotification(method, handler)
  }

  // ---- Generic LSP passthrough -------------------------------------------
  // These mirror the public surface of vscode-lean4's `LeanClient`, so this
  // connection can stand in for a real `LeanClient` behind the host bridge.

  /** Forward an arbitrary LSP request to the server. */
  sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.connection.sendRequest(method, params) as Promise<T>
  }

  /** Forward an arbitrary LSP notification to the server. */
  async sendNotification(method: string, params: unknown): Promise<void> {
    await this.connection.sendNotification(method, params)
  }

  /** Subscribe to a server->client notification by method name. */
  onServerNotification(method: string, handler: (params: unknown) => void): { dispose(): void } {
    return this.connection.onNotification(method, handler)
  }

  /** The server's initialize result (for `LeanClientLike`). */
  getInitializeResult(): { serverInfo?: { name?: string; version?: string }; capabilities?: unknown } | undefined {
    if (!this.initializeResult) return undefined
    return { serverInfo: this.initializeResult.serverInfo, capabilities: this.initializeResult.capabilities }
  }

  /** Current tracked diagnostics per uri (for `LeanClientLike`). Requires `trackDiagnostics()`. */
  getDiagnostics(): Array<{ uri: string; diagnostics: unknown[] }> {
    return [...this.latestDiagnostics.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }))
  }

  openTextDocument(uri: string, text: string, languageId = 'lean4', version = 1): void {
    this.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    })
  }

  /**
   * Resolve once the server reports that `uri` is finished elaborating, i.e. a
   * `$/lean/fileProgress` notification arrives with an empty `processing` array.
   * Resolves on timeout too (the caller still retries the actual RPC call).
   */
  waitForElaboration(uri: string, timeoutMs = 30_000): Promise<'done' | 'timeout'> {
    return new Promise(resolve => {
      let settled = false
      const finish = (how: 'done' | 'timeout') => {
        if (settled) return
        settled = true
        sub.dispose()
        clearTimeout(timer)
        resolve(how)
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      const sub = this.connection.onNotification(
        LeanNotification.fileProgress,
        (params: LeanFileProgressParams) => {
          if (params.textDocument.uri !== uri) return
          if (params.processing.length === 0) finish('done')
        },
      )
    })
  }

  collectDiagnostics(uri: string): Diagnostic[] {
    return this.latestDiagnostics.get(uri) ?? []
  }
  private latestDiagnostics = new Map<string, Diagnostic[]>()
  trackDiagnostics(): void {
    this.connection.onNotification(
      LeanNotification.publishDiagnostics,
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        this.latestDiagnostics.set(params.uri, params.diagnostics)
      },
    )
  }

  // ---- Custom RPC ---------------------------------------------------------

  /** Open an RPC session for `uri` and start sending keepalives on its behalf. */
  async rpcConnect(uri: string): Promise<string> {
    const params: RpcConnectParams = { uri }
    const result = (await this.connection.sendRequest(LeanRpcMethod.connect, params)) as RpcConnected
    const sessionId = result.sessionId
    const timer = setInterval(() => {
      const ka: RpcKeepAliveParams = { uri, sessionId }
      this.connection.sendNotification(LeanRpcMethod.keepAlive, ka).catch(e => this.log(`keepAlive failed: ${e}`))
    }, KEEPALIVE_PERIOD_MS)
    this.keepAliveTimers.set(sessionId, timer)
    return sessionId
  }

  closeRpcSession(sessionId: string): void {
    const timer = this.keepAliveTimers.get(sessionId)
    if (timer) {
      clearInterval(timer)
      this.keepAliveTimers.delete(sessionId)
    }
  }

  /** Make a single RPC call within a session at a position. */
  async rpcCall<T = unknown>(
    sessionId: string,
    uri: string,
    position: Position,
    method: string,
    innerParams: unknown,
  ): Promise<T> {
    const params: RpcCallParams = {
      sessionId,
      method,
      params: innerParams,
      textDocument: { uri },
      position,
    }
    const result = await this.connection.sendRequest(LeanRpcMethod.call, params)
    return (result === null ? undefined : result) as T
  }

  getInteractiveGoals(sessionId: string, uri: string, position: Position): Promise<InteractiveGoals | undefined> {
    const tdpp = { textDocument: { uri }, position }
    return this.rpcCall<InteractiveGoals | undefined>(
      sessionId,
      uri,
      position,
      LeanWidgetRpc.getInteractiveGoals,
      tdpp,
    )
  }

  getInteractiveTermGoal(
    sessionId: string,
    uri: string,
    position: Position,
  ): Promise<InteractiveTermGoal | undefined> {
    const tdpp = { textDocument: { uri }, position }
    return this.rpcCall<InteractiveTermGoal | undefined>(
      sessionId,
      uri,
      position,
      LeanWidgetRpc.getInteractiveTermGoal,
      tdpp,
    )
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.keepAliveTimers.values()) clearInterval(timer)
    this.keepAliveTimers.clear()
    try {
      await this.connection.sendRequest('shutdown').catch(() => {})
      this.connection.sendNotification('exit').catch(() => {})
    } catch {
      /* ignore */
    }
    this.connection?.dispose()
    if (this.child && !this.child.killed) this.child.kill()
  }
}
