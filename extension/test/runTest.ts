import { runTests } from '@vscode/test-electron'
import { resolve } from 'node:path'

async function main() {
  try {
    const extensionDevelopmentPath = resolve(__dirname, '..')
    const extensionTestsPath = resolve(__dirname, 'suite', 'index.js')
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'],
    })
  } catch (err) {
    console.error('Failed to run tests:', err)
    process.exit(1)
  }
}

void main()
