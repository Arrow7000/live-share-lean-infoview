// Stamp package.json with a monotonically increasing version so that the most
// recently published build always wins. We deliberately avoid hand-managed
// semver during alpha: the version is `0.0.<unix-seconds>`, which is a valid
// semver, always increases over time, and is trivially comparable by the
// in-extension updater (see src/autoUpdate.ts).
//
// CI runs this before packaging on a throwaway checkout. Locally it mutates
// package.json, so revert it afterwards (`git checkout package.json`) if you
// don't intend to commit the stamped version.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = join(here, '..', 'package.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = `0.0.${Math.floor(Date.now() / 1000)}`
pkg.version = version
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// Surface the value for downstream CI steps (GitHub Actions output).
const ghOutput = process.env.GITHUB_OUTPUT
if (ghOutput) {
  writeFileSync(ghOutput, `version=${version}\n`, { flag: 'a' })
}

console.log(version)
