// Build the extension (node/CJS) and the webview bootstrap (browser/IIFE), and
// copy the @leanprover/infoview dist assets the webview loads at runtime.

import { build, context } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const watch = process.argv.includes('--watch')

const infoviewDist = join(dirname(require.resolve('@leanprover/infoview/package.json')), 'dist')
const mediaInfoview = join(here, 'media', 'infoview')

function copyAssets() {
  rmSync(mediaInfoview, { recursive: true, force: true })
  mkdirSync(mediaInfoview, { recursive: true })
  cpSync(infoviewDist, mediaInfoview, { recursive: true })
  console.log(`[assets] copied @leanprover/infoview/dist -> ${mediaInfoview}`)
}

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: [join(here, 'src', 'extension.ts')],
  outfile: join(here, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // `vscode` is provided by the host; `ws` pulls optional native deps it loads
  // in a try/catch (it falls back to JS), so we leave them external.
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: [join(here, 'webview', 'main.ts')],
  outfile: join(here, 'media', 'webview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  // No externals: the only static import is `@leanprover/infoview/loader` (which
  // bundles es-module-shims and must be included). The infoview app + react are
  // referenced only as importmap *strings* and loaded at runtime via importShim.
  sourcemap: true,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const testOptions = {
  entryPoints: [join(here, 'test', 'runTest.ts'), join(here, 'test', 'suite', 'index.ts')],
  outdir: join(here, 'dist-test'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', '@vscode/test-electron', 'mocha'],
  sourcemap: true,
  logLevel: 'info',
}

copyAssets()

if (watch) {
  const ctxs = await Promise.all([context(extensionOptions), context(webviewOptions)])
  await Promise.all(ctxs.map(c => c.watch()))
  console.log('[esbuild] watching...')
} else {
  await Promise.all([build(extensionOptions), build(webviewOptions), build(testOptions)])
  console.log('[esbuild] build complete')
}
