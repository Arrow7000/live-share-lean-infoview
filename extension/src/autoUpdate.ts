// Self-update from GitHub Releases.
//
// VS Code / Cursor only auto-update extensions that come from a gallery
// (the Marketplace, or Open VSX). A side-loaded .vsix never updates itself, so
// for GitHub-hosted distribution we do it by hand: on startup we ask the GitHub
// Releases API for the newest build, and if it is newer than what is installed
// we download the .vsix and install it via the built-in
// `workbench.extensions.installExtension` command, then offer a reload.
//
// "Newest = latest" is enforced by the build: every release is versioned
// `0.0.<unix-seconds>` (see scripts/stamp-version.mjs), so a strictly larger
// patch number always means a more recent build — no hand-managed semver.

import * as vscode from 'vscode'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const LAST_CHECK_KEY = 'leanLiveShare.autoUpdate.lastCheck'
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000 // at most once every 6h on startup
const USER_AGENT = 'lean4-live-share-infoview'

type Logger = (line: string) => void

interface ReleaseAsset {
  name: string
  browser_download_url: string
}
interface Release {
  tag_name: string
  name: string | null
  html_url: string
  assets: ReleaseAsset[]
}

/**
 * Register the "Check for Updates" command and, on a production install, kick off
 * a throttled background update check. No-ops for source/dev/test hosts.
 */
export function registerAutoUpdate(context: vscode.ExtensionContext, log: Logger): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('leanLiveShare.checkForUpdates', () =>
      checkForUpdates(context, log, { manual: true }),
    ),
  )

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    log('auto-update: skipped automatic check (not a production install)')
    return
  }
  void checkForUpdates(context, log, { manual: false })
}

async function checkForUpdates(
  context: vscode.ExtensionContext,
  log: Logger,
  opts: { manual: boolean },
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration('leanLiveShare')
    if (!opts.manual && !config.get<boolean>('autoUpdate.enabled', true)) {
      log('auto-update: disabled via leanLiveShare.autoUpdate.enabled')
      return
    }

    if (!opts.manual) {
      const last = context.globalState.get<number>(LAST_CHECK_KEY, 0)
      if (Date.now() - last < CHECK_THROTTLE_MS) {
        log('auto-update: skipped (checked recently)')
        return
      }
    }
    await context.globalState.update(LAST_CHECK_KEY, Date.now())

    const slug = repoSlug(context)
    if (!slug) {
      log('auto-update: no GitHub repository configured in package.json; skipping')
      if (opts.manual) {
        void vscode.window.showWarningMessage('Lean Live Share: no update repository is configured.')
      }
      return
    }

    const currentVersion = String(context.extension.packageJSON.version ?? '0.0.0')
    log(`auto-update: checking ${slug} (installed ${currentVersion})`)

    const release = await fetchLatestRelease(slug, log)
    if (!release) {
      log('auto-update: no published release found')
      if (opts.manual) {
        void vscode.window.showInformationMessage('Lean Live Share: no releases published yet.')
      }
      return
    }

    const latestVersion = normalizeVersion(release.tag_name)
    log(`auto-update: latest release ${release.tag_name} (${latestVersion})`)

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (opts.manual) {
        void vscode.window.showInformationMessage(`Lean Live Share is up to date (${currentVersion}).`)
      }
      return
    }

    const asset = release.assets.find(a => a.name.toLowerCase().endsWith('.vsix'))
    if (!asset) {
      log('auto-update: latest release has no .vsix asset')
      if (opts.manual) {
        void vscode.window.showWarningMessage('Lean Live Share: the latest release has no .vsix asset.')
      }
      return
    }

    await installUpdate(context, log, asset, latestVersion)
  } catch (e) {
    log(`auto-update: check failed: ${describe(e)}`)
    if (opts.manual) {
      void vscode.window.showErrorMessage(`Lean Live Share update check failed: ${describe(e)}`)
    }
  }
}

async function installUpdate(
  context: vscode.ExtensionContext,
  log: Logger,
  asset: ReleaseAsset,
  version: string,
): Promise<void> {
  try {
    const vsixPath = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Lean Live Share: updating to ${version}…` },
      async () => {
        const downloaded = await downloadAsset(context, asset, log)
        log(`auto-update: installing ${downloaded}`)
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(downloaded))
        return downloaded
      },
    )
    await fs.rm(vsixPath, { force: true }).catch(() => {})

    const reload = 'Reload Window'
    const choice = await vscode.window.showInformationMessage(
      `Lean Live Share updated to ${version}. Reload to apply.`,
      reload,
    )
    if (choice === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
  } catch (e) {
    log(`auto-update: install failed: ${describe(e)}`)
    const open = 'Open Releases'
    const choice = await vscode.window.showErrorMessage(
      `Lean Live Share couldn't install the update automatically: ${describe(e)}`,
      open,
    )
    if (choice === open) {
      const slug = repoSlug(context)
      if (slug) {
        void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${slug}/releases/latest`))
      }
    }
  }
}

async function downloadAsset(
  context: vscode.ExtensionContext,
  asset: ReleaseAsset,
  log: Logger,
): Promise<string> {
  const dir = context.globalStorageUri.fsPath
  await fs.mkdir(dir, { recursive: true })
  const dest = path.join(dir, asset.name)

  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(dest, bytes)
  log(`auto-update: downloaded ${bytes.length} bytes -> ${dest}`)
  return dest
}

async function fetchLatestRelease(slug: string, log: Logger): Promise<Release | undefined> {
  const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
  })
  if (res.status === 404) return undefined
  if (!res.ok) {
    if (res.status === 403) {
      log('auto-update: GitHub API rate-limited (403); will retry on a later startup')
    }
    throw new Error(`GitHub API HTTP ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as Release
}

/** Derive `owner/repo` from the package.json `repository` field. */
function repoSlug(context: vscode.ExtensionContext): string | undefined {
  const repo = context.extension.packageJSON.repository as { url?: string } | string | undefined
  const url = typeof repo === 'string' ? repo : repo?.url
  if (!url) return undefined
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url)
  return m ? `${m[1]}/${m[2]}` : undefined
}

function normalizeVersion(tag: string): string {
  return tag.replace(/^v/i, '').trim()
}

/** Numeric per-component compare of `a.b.c` version strings. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
