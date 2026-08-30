#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const repoRoot = path.resolve(appRoot, '../..')
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const config = JSON.parse(readFileSync(path.join(appRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const packConfig = JSON.parse(readFileSync(path.join(appRoot, 'src-tauri', 'tauri.pack.conf.json'), 'utf8'))
const versions = JSON.parse(readFileSync(path.join(appRoot, 'versions.json'), 'utf8'))
const cargo = readFileSync(path.join(appRoot, 'src-tauri', 'Cargo.toml'), 'utf8')
const errors = []

if (rootPackage.version !== config.version) {
  errors.push(`Tauri config version ${config.version} != root ${rootPackage.version}`)
}
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (cargoVersion !== rootPackage.version) {
  errors.push(`Tauri Cargo version ${cargoVersion ?? '<missing>'} != root ${rootPackage.version}`)
}
if (config.identifier !== 'com.dsh.client.tauri.next') {
  errors.push('Tauri Next must keep the side-by-side app id com.dsh.client.tauri.next until release promotion.')
}
if (!cargo.includes(`tauri = { version = "=${versions.tauriCore}"`)) {
  errors.push(`Cargo.toml must pin Tauri core exactly to ${versions.tauriCore}.`)
}
if (packConfig.bundle?.active !== true || packConfig.bundle?.resources?.['resources/'] !== '') {
  errors.push('Tauri package config must activate bundling and map staged resources to the bundle resource root.')
}
for (const required of [
  path.join(appRoot, 'bridge', 'main.ts'),
  path.join(appRoot, 'frontend', 'index.html'),
  path.join(appRoot, 'src-tauri', 'icons', 'icon.png'),
  path.join(appRoot, 'src-tauri', 'icons', 'icon.ico'),
  path.join(appRoot, 'src-tauri', 'tauri.pack.conf.json'),
  path.join(repoRoot, 'apps', 'desktop', 'build', 'icons', '1024x1024.png'),
  path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'),
  path.join(repoRoot, 'packages', 'plugin-embedded-client', 'lib', 'index.js'),
]) {
  if (!existsSync(required)) errors.push(`Missing Tauri input: ${required}`)
}

if (errors.length) {
  console.error('check:tauri-host FAILED:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(
  `check:tauri-host OK: client=${rootPackage.version} core=${versions.tauriCore} cli=${versions.tauriCli} appId=${config.identifier}`,
)
