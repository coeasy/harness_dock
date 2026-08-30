#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versions = JSON.parse(await readFile(path.join(appRoot, 'versions.json'), 'utf8'))
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: node scripts/tauri-cli.mjs <tauri command> [...args]')
  process.exit(2)
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(command, ['dlx', `@tauri-apps/cli@${versions.tauriCli}`, ...args], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})
child.once('error', (error) => {
  console.error(`[tauri-cli] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
child.once('close', (code) => {
  process.exitCode = code ?? 1
})
