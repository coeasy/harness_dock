#!/usr/bin/env node
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DshRuntime } from './runtime.ts'
import { redactWebAuthTokens } from './output.ts'
import { openWebUiSession, probeWebUiSession } from './web-auth.ts'
import { assertBundledRuntimeIntegrity, repairKnownRuntimeAssets } from './integrity.ts'

const cliArgs = process.argv.slice(2)
if (cliArgs[0] === '--') cliArgs.shift()

const { values } = parseArgs({
  args: cliArgs,
  options: {
    'runtime-dir': { type: 'string' },
    plugin: { type: 'string' },
  },
})
if (!values['runtime-dir'] || !values.plugin) {
  throw new Error('usage: smoke-runtime --runtime-dir <dir> --plugin <index.js>')
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const resolveInput = (value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
const runtimeDir = resolveInput(values['runtime-dir'])
const pluginPath = resolveInput(values.plugin)
const compatibilityPath = path.join(
  repoRoot,
  'apps',
  'tauri',
  'src-tauri',
  'resources',
  'dsh-client-runtime-compat',
  'index.js',
)
const manifest = JSON.parse(
  await readFile(path.join(runtimeDir, 'manifest.json'), 'utf8'),
) as { dshVersion?: unknown; platform?: unknown; arch?: unknown }
if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
  console.log(
    `[smoke] skipped executable boot: target=${manifest.platform}/${manifest.arch} host=${process.platform}/${process.arch}`,
  )
  process.exit(0)
}
if (typeof manifest.dshVersion !== 'string' || manifest.dshVersion === '') {
  throw new Error('runtime manifest has no dshVersion')
}

// GitHub Actions artifact ZIPs do not preserve POSIX executable bits. Repair
// every known runtime asset after download and before the smoke gate so the
// exact tree Tauri packages has the same executable/integrity guarantees as
// the runtime prepared in the previous job. This includes the Linux Landlock
// sandbox helper, not just the Node launcher.
if (process.platform !== 'win32') {
  const nodePath = path.join(runtimeDir, 'bin', 'node')
  await chmod(nodePath, 0o755)
}
const repaired = await repairKnownRuntimeAssets(runtimeDir)
if (repaired.length > 0) {
  console.log(`[smoke] repaired artifact assets: ${repaired.join(', ')}`)
}
await assertBundledRuntimeIntegrity(runtimeDir, process.platform, process.arch)

const home = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-smoke-home-'))
const work = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-smoke-work-'))
const logs: string[] = []
const runtime = new DshRuntime({
  origin: { dshVersion: manifest.dshVersion },
  pluginPath,
  compatibilityPath,
  bundledRoot: runtimeDir,
  cacheDir: work,
  readyTimeoutMs: 120_000,
  readyStabilityMs: 2_000,
  env: {
    DSH_RUNTIME: 'bundled',
    DSH_HOME: home,
  },
  log: (message) => {
    logs.push(message)
    process.stdout.write(`[smoke] ${message}\n`)
  },
})

try {
  const ready = await runtime.start()
  const session = await openWebUiSession(ready.url, { timeoutMs: 3_000, requireHtml: true })
  if (!session) {
    throw new Error('web UI authentication/readiness handshake failed')
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  if (!(await probeWebUiSession(session, { timeoutMs: 3_000, requireHtml: true }))) {
    throw new Error('web UI authenticated session did not remain healthy')
  }
  console.log(
    `[smoke] PASS ${redactWebAuthTokens(ready.url)} remained healthy with dsh ${ready.dshVersion}`,
  )
} catch (error) {
  const tail = logs.slice(-20).join('\n')
  throw new Error(
    `bundled runtime smoke test failed: ${error instanceof Error ? error.message : String(error)}` +
      (tail ? `\nLast runtime logs:\n${tail}` : ''),
    { cause: error },
  )
} finally {
  await runtime.stop()
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(work, { recursive: true, force: true }),
  ])
}
