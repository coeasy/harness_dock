#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))

const base = readJson('apps/tauri/src-tauri/tauri.conf.json')
const android = readJson('apps/tauri/src-tauri/tauri.android.conf.json')
const ios = readJson('apps/tauri/src-tauri/tauri.ios.conf.json')
const capability = readJson('apps/tauri/src-tauri/capabilities/mobile-remote.json')

const expectedPermissions = ['platform-info', 'gateway-health', 'gateway-pair']
const forbiddenPermissions = [
  'core:default',
  'gateway-host',
  'runtime-start',
  'runtime-stop',
  'runtime-maintenance',
  'update-check',
  'update-install',
  'harness-window',
  'host-protocol',
]

if (!base.app?.security?.capabilities?.includes('mobile-remote')) {
  throw new Error('tauri.conf.json does not register mobile-remote capability')
}
if (capability.identifier !== 'mobile-remote') throw new Error('unexpected mobile capability identifier')
if (JSON.stringify(capability.windows) !== JSON.stringify(['main'])) {
  throw new Error(`mobile capability must be scoped only to window "main": ${JSON.stringify(capability.windows)}`)
}
const platforms = new Set(capability.platforms ?? [])
if (!platforms.has('android') || !platforms.has('iOS') || platforms.size !== 2) {
  throw new Error(`mobile capability must be android/iOS only: ${JSON.stringify(capability.platforms)}`)
}
const permissions = capability.permissions ?? []
if (JSON.stringify([...permissions].sort()) !== JSON.stringify([...expectedPermissions].sort())) {
  throw new Error(`mobile permissions drift: ${JSON.stringify(permissions)}`)
}
for (const forbidden of forbiddenPermissions) {
  if (permissions.includes(forbidden)) throw new Error(`mobile capability gained forbidden permission ${forbidden}`)
}
for (const [platform, config] of [['android', android], ['iOS', ios]]) {
  const windows = config.app?.windows ?? []
  if (windows.length !== 1 || windows[0]?.label !== 'main' || windows[0]?.visible !== true) {
    throw new Error(`${platform} must boot directly into the visible main remote-pairing window`)
  }
}

console.log('[mobile-contract] remote-only main window + 3 least-privilege Gateway permissions verified')
