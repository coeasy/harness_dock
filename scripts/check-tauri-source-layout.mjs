#!/usr/bin/env node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const required = [
  'apps/tauri/src-tauri/Cargo.lock',
  'apps/tauri/src-tauri/src/runtime/mod.rs',
  'apps/tauri/src-tauri/src/gateway_host/mod.rs',
  'apps/tauri/src-tauri/src/harness_window/mod.rs',
  'apps/tauri/src-tauri/src/util.rs',
  'apps/tauri/src-tauri/src/error.rs',
]

const forbiddenLegacy = [
  'apps/tauri/src-tauri/src/runtime.rs',
  'apps/tauri/src-tauri/src/gateway_host.rs',
  'apps/tauri/src-tauri/src/harness_window.rs',
]

const missing = required.filter((relative) => !existsSync(path.join(root, relative)))
const stale = forbiddenLegacy.filter((relative) => existsSync(path.join(root, relative)))

if (missing.length || stale.length) {
  if (missing.length) console.error(`[tauri-layout] missing required paths: ${missing.join(', ')}`)
  if (stale.length) console.error(`[tauri-layout] legacy pre-split paths returned: ${stale.join(', ')}`)
  process.exit(1)
}

console.log(`[tauri-layout] ${required.length} canonical module paths present; no legacy pre-split modules`) 
