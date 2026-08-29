#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectBundledModules } from './bundled.ts'
import { scrubElectronEnv } from './env.ts'
import { buildLaunchArgs, renderEmbeddedPatch } from './launch.ts'
import { isProcessAlive, shutdownLadder } from './process.ts'
import { parseReadyFile } from './ready.ts'

const cliArgs = process.argv.slice(2)
if (cliArgs[0] === '--') cliArgs.shift()
const { values } = parseArgs({
  args: cliArgs,
  options: {
    'runtime-dir': { type: 'string' },
    plugin: { type: 'string' },
    electron: { type: 'string' },
  },
})
if (!values['runtime-dir'] || !values.plugin || !values.electron) {
  throw new Error('usage: smoke-thin-runtime --runtime-dir <dir> --plugin <index.js> --electron <executable>')
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const abs = (value: string): string => path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
const runtimeDir = abs(values['runtime-dir'])
const pluginPath = abs(values.plugin)
const electron = abs(values.electron)
const modules = inspectBundledModules(runtimeDir)
if (!modules) throw new Error(`thin runtime has no dsh module seed: ${runtimeDir}`)
const manifest = JSON.parse(await readFile(path.join(runtimeDir, 'manifest.json'), 'utf8')) as {
  dshVersion?: string
  platform?: string
  arch?: string
}
if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
  console.log(`[thin-smoke] skipped native boot: target=${manifest.platform}/${manifest.arch} host=${process.platform}/${process.arch}`)
  process.exit(0)
}
if (!manifest.dshVersion) throw new Error('thin runtime manifest has no dshVersion')

const home = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-thin-home-'))
const work = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-thin-work-'))
const patchFile = path.join(work, 'embedded.patch.yml')
const readyFile = path.join(work, 'ready.json')
await writeFile(patchFile, renderEmbeddedPatch(pluginPath), 'utf8')

const env = scrubElectronEnv({
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DSH_PRESERVE_ELECTRON_RUN_AS_NODE: '1',
  DSH_EMBEDDED_READY_FILE: readyFile,
  DSH_EMBEDDED_VERSION: manifest.dshVersion,
  DSH_HOME: home,
})
const child = spawn(electron, [modules.dshBin, ...buildLaunchArgs({ patchFile })], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', (chunk) => process.stdout.write(`[thin-smoke] ${String(chunk)}`))
child.stderr.on('data', (chunk) => process.stderr.write(`[thin-smoke] ${String(chunk)}`))

async function waitReady(): Promise<ReturnType<typeof parseReadyFile>> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Electron Node child exited early with ${child.exitCode}`)
    try {
      const ready = parseReadyFile(await readFile(readyFile, 'utf8'))
      if (ready) return ready
    } catch {
      // file not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('timed out waiting for packaged Thin runtime readiness')
}

try {
  const ready = await waitReady()
  const response = await fetch(ready.url)
  const body = await response.text()
  if (!response.ok || !/<html(?:\s|>)/i.test(body)) {
    throw new Error(`Thin web UI probe failed: HTTP ${response.status}, ${body.length} bytes`)
  }
  if (/DSH_BOOT/.test(body) && /["']?entries["']?\s*:\s*\[\s*\]/.test(body)) {
    throw new Error('Thin web UI has empty DSH_BOOT entries')
  }
  if (/DSH_BOOT/.test(body) && !body.includes('@deepseek-ai/dsh-client-modules')) {
    throw new Error('Thin alpha web UI did not preload @deepseek-ai/dsh-client-modules')
  }
  console.log(`[thin-smoke] PASS ${ready.url} with dsh ${ready.dshVersion}`)
} finally {
  if (child.pid && isProcessAlive(child.pid)) {
    await shutdownLadder(child, { termMs: 5_000, killMs: 3_000, isAlive: () => isProcessAlive(child.pid) })
  }
  await Promise.all([rm(home, { recursive: true, force: true }), rm(work, { recursive: true, force: true })])
}
