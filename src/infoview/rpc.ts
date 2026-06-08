/**
 * Minimal symmetric JSON-RPC over a `postMessage`-style channel, used for the
 * webview <-> extension-host hop. Ported from vscode-lean4's `src/rpc.ts` (the
 * webview and host must speak the same protocol) and kept framework-agnostic so
 * it runs in the webview bundle, the extension host, and headless tests.
 */

import type { ClientRequestOptions, EditorApi, EditorRpcApi } from './api.js'

export class Rpc {
  private seqNum = 0
  private methods: { [name: string]: (...args: any[]) => Promise<any> } = {}
  private pending: { [seqNum: number]: { resolve: (_: any) => void; reject: (_: any) => void } } = {}
  private initPromise: Promise<void>
  private resolveInit: () => void = () => {}
  private initialized = false

  constructor(readonly sendMessage: (msg: any) => void) {
    this.initPromise = new Promise(resolve => {
      this.resolveInit = resolve
    })
  }

  /** Register the procedures the other side can invoke. Must be called once. */
  register<T>(methods: T): void {
    if (this.initialized) throw new Error('RPC methods already registered')
    this.methods = { ...methods } as any
    const interval = setInterval(() => this.sendMessage({ kind: 'initialize' }), 50)
    const prevResolveInit = this.resolveInit
    this.resolveInit = () => {
      clearInterval(interval)
      prevResolveInit()
    }
    this.initialized = true
  }

  messageReceived(msg: any): void {
    if (msg.kind) {
      if (msg.kind === 'initialize') this.sendMessage({ kind: 'initialized' })
      else if (msg.kind === 'initialized' && this.initialized) this.resolveInit()
      return
    }
    const { seqNum, name, args, result, exception }: any = msg
    if (seqNum === undefined) return
    if (name !== undefined) {
      void this.initPromise.then(async () => {
        try {
          const fn = this.methods[name]
          if (fn === undefined) throw new Error(`unknown RPC method ${name}`)
          this.sendMessage({ seqNum, result: await fn(...args) })
        } catch (ex: any) {
          this.sendMessage({ seqNum, exception: prepareExceptionForSerialization(ex) })
        }
      })
      return
    }
    if (this.pending[seqNum] === undefined) return
    if (exception !== undefined) this.pending[seqNum].reject(exception)
    else this.pending[seqNum].resolve(result)
    delete this.pending[seqNum]
  }

  async invoke(name: string, args: any[]): Promise<any> {
    await this.initPromise
    this.seqNum += 1
    const seqNum = this.seqNum
    return new Promise((resolve, reject) => {
      this.pending[seqNum] = { resolve, reject }
      this.sendMessage({ seqNum, name, args })
    })
  }

  getApi<T>(): T {
    return new Proxy(
      {},
      {
        get:
          (_, prop) =>
          (...args: any[]) =>
            this.invoke(prop as string, args),
      },
    ) as any
  }
}

function prepareExceptionForSerialization(ex: any): any {
  if (ex === undefined) return 'error'
  if (typeof ex === 'object' && !(ex instanceof Array)) {
    const out: any = {}
    for (const p of Object.getOwnPropertyNames(ex)) out[p] = ex[p]
    return out
  }
  return ex
}

interface CancellationData {
  id: number | undefined
  shouldCancel: boolean
  cancelled: boolean
}

/** Wrap a serializable {@link EditorRpcApi} as the convenient {@link EditorApi}. */
export function editorApiOfRpc(api: EditorRpcApi): EditorApi {
  function cancel(d: CancellationData) {
    d.shouldCancel = true
    if (d.id !== undefined && !d.cancelled) {
      void api.cancelClientRequest(d.id)
      d.cancelled = true
    }
  }
  return {
    sendClientRequest(uri: string, method: string, params: unknown, options?: ClientRequestOptions) {
      const d: CancellationData = { id: undefined, shouldCancel: false, cancelled: false }
      const promise = (async () => {
        const id = await api.startClientRequest(uri, method, params)
        d.id = id
        if (d.shouldCancel) cancel(d)
        return api.awaitClientRequest(id)
      })()
      if (options?.abortSignal) options.abortSignal.addEventListener('abort', () => cancel(d))
      return promise
    },
    saveConfig: api.saveConfig,
    sendClientNotification: api.sendClientNotification,
    subscribeServerNotifications: api.subscribeServerNotifications,
    unsubscribeServerNotifications: api.unsubscribeServerNotifications,
    subscribeClientNotifications: api.subscribeClientNotifications,
    unsubscribeClientNotifications: api.unsubscribeClientNotifications,
    copyToClipboard: api.copyToClipboard,
    insertText: api.insertText,
    applyEdit: api.applyEdit,
    showDocument: api.showDocument,
    restartFile: api.restartFile,
    createRpcSession: api.createRpcSession,
    closeRpcSession: api.closeRpcSession,
  }
}
