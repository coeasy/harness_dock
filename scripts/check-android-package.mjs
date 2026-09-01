#!/usr/bin/env node
/**
 * Android release package guard.
 *
 * A debug APK keeps a large unstripped Rust/Tauri shared library and can be
 * more than 150 MB. Release builds must be inspected before they become a
 * candidate artifact so a debug package cannot be published by accident.
 */

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

const MB = 1024 * 1024
const APK_BUDGET = 96 * MB
const AAB_BUDGET = 64 * MB
const NATIVE_BUDGET = 64 * MB
const inputs = process.argv.slice(2)

if (inputs.length === 0) {
  console.error('usage: node scripts/check-android-package.mjs <apk> [aab]')
  process.exit(1)
}

function inspect(file) {
  const name = path.basename(file)
  const bytes = statSync(file).size
  const listing = execFileSync('unzip', ['-lv', file], { encoding: 'utf8' })
  const nativeBytes = listing
    .split('\n')
    .filter((line) => /\blib\/[^ ]+\/lib[^ ]+\.so$/.test(line.trim()))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .reduce((largest, value) => Math.max(largest, value), 0)
  const isApk = name.toLowerCase().endsWith('.apk')
  const budget = isApk ? APK_BUDGET : AAB_BUDGET
  const failures = []

  if (/(^|[-_.])debug([-. _]|$)/i.test(name)) failures.push('文件名包含 debug')
  if (bytes > budget) failures.push(`包体 ${ (bytes / MB).toFixed(1) } MB > ${(budget / MB).toFixed(1)} MB`)
  if (nativeBytes > NATIVE_BUDGET) failures.push(`最大 native .so ${(nativeBytes / MB).toFixed(1)} MB > ${(NATIVE_BUDGET / MB).toFixed(1)} MB`)

  console.log(`[android-size] ${name}: ${(bytes / MB).toFixed(1)} MB; largest native .so ${(nativeBytes / MB).toFixed(1)} MB`)
  for (const failure of failures) console.error(`[android-size] FAIL ${name}: ${failure}`)
  return failures.length
}

const failures = inputs.reduce((count, file) => count + inspect(file), 0)
if (failures > 0) process.exit(1)
console.log('[android-size] release package budgets pass.')
