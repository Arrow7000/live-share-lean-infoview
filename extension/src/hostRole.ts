import * as vscode from 'vscode'
import type * as vsls from 'vsls'
import { LeanBridgeHost } from '../../src/bridge/leanBridgeHost.js'
import { createHostChannel } from '../../src/bridge/liveShareChannel.js'
import { makeUriTranslatingHostChannel } from '../../src/bridge/uriTranslation.js'
import { adaptLeanClient, type RealLeanClient } from './leanClientAdapter.js'
import { SERVICE_NAME } from './protocol.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Get vscode-lean4's `clientProvider` (which hands out `LeanClient`s) via its public exports. */
async function getClientProvider(log: (s: string) => void): Promise<{ getClients(): RealLeanClient[]; clientAdded?: vscode.Event<RealLeanClient> } | undefined> {
  const leanExt = vscode.extensions.getExtension('leanprover.lean4')
  if (!leanExt) {
    log('HOST: vscode-lean4 (leanprover.lean4) is not installed — cannot bridge the Lean server.')
    return undefined
  }
  try {
    const exports: any = await leanExt.activate()
    const features = await exports.lean4EnabledFeatures
    return features.clientProvider
  } catch (e) {
    log(`HOST: failed to obtain vscode-lean4 clientProvider: ${describe(e)}`)
    return undefined
  }
}

/**
 * Wire the host side: share the bridge service, obtain the host's real Lean
 * client, and relay the guest's RPC to it (with vsls<->file URI translation).
 */
export async function startHostRole(api: vsls.LiveShare, log: (s: string) => void): Promise<vscode.Disposable> {
  log(`HOST: sharing service '${SERVICE_NAME}'...`)
  const service = await api.shareService(SERVICE_NAME)
  if (!service) {
    log('HOST: shareService returned null — Live Share may not permit this extension to share a service.')
    return { dispose: () => {} }
  }
  log('HOST: service shared.')

  const clientProvider = await getClientProvider(log)
  if (!clientProvider) {
    return { dispose: () => void api.unshareService(SERVICE_NAME) }
  }

  // Wait briefly for a Lean client to exist (the host should have a Lean file open).
  for (let i = 0; i < 40 && clientProvider.getClients().length === 0; i++) await sleep(250)
  if (clientProvider.getClients().length === 0) {
    log('HOST: no Lean client yet. Open a Lean file in the shared project on the host. Will resolve lazily.')
  } else {
    log(`HOST: ${clientProvider.getClients().length} Lean client(s) available.`)
  }

  const toLocal = (s: string) => safeConvert(() => api.convertSharedUriToLocal(vscode.Uri.parse(s)).toString(), s)
  const toShared = (s: string) => safeConvert(() => api.convertLocalUriToShared(vscode.Uri.parse(s)).toString(), s)

  const adapter = adaptLeanClient(() => clientProvider.getClients()[0], log)
  const channel = makeUriTranslatingHostChannel(createHostChannel(service), { incoming: toLocal, outgoing: toShared })
  const bridge = new LeanBridgeHost(channel, adapter, { log })
  log('HOST: bridge is live; guests can now open the Lean infoview.')

  return {
    dispose: () => {
      bridge.dispose()
      void api.unshareService(SERVICE_NAME)
      log('HOST: bridge disposed, service unshared.')
    },
  }
}

function safeConvert(fn: () => string, fallback: string): string {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
