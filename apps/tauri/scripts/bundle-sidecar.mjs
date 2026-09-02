#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const tauriRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(tauriRoot, '../..')
const output = path.join(tauriRoot, 'src-tauri', 'resources', 'gateway-sidecar.mjs')

await mkdir(path.dirname(output), { recursive: true })
await build({
  entryPoints: [path.join(repoRoot, 'packages/bootstrap/src/gateway-sidecar.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: output,
  legalComments: 'none',
})
console.log(`[tauri] bundled Gateway sidecar -> ${path.relative(repoRoot, output)}`)
