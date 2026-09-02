#!/usr/bin/env node
/**
 * Android package guard.
 *
 * Smoke jobs pass one APK and may use the standard Android debug certificate.
 * Release-candidate jobs pass APK + AAB; both packages must be signed and the
 * debug certificate is rejected so an unsigned/debug artifact can never be
 * renamed to `release` by the publishing workflow.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const MB = 1024 * 1024
const APK_BUDGET = 96 * MB
const AAB_BUDGET = 64 * MB
const NATIVE_BUDGET = 64 * MB
const inputs = process.argv.slice(2)
const releaseCandidate = inputs.some((file) => file.toLowerCase().endsWith('.aab'))

if (inputs.length === 0) {
  console.error('usage: node scripts/check-android-package.mjs <apk> [aab]')
  process.exit(1)
}

function commandOutput(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function androidBuildTools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!sdk) return []
  const root = path.join(sdk, 'build-tools')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((version) => path.join(root, version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'))
    .filter(existsSync)
}

function apkSigner() {
  const candidates = androidBuildTools()
  if (candidates.length > 0) return candidates[0]
  try {
    commandOutput('apksigner', ['version'])
    return 'apksigner'
  } catch {
    throw new Error('Android apksigner 不可用，无法验证 APK 签名。请确保 Android SDK build-tools 已安装。')
  }
}

function verifyApkSignature(file, failures) {
  try {
    const output = commandOutput(apkSigner(), ['verify', '--verbose', '--print-certs', file])
    if (!/Verified using v\d scheme.*true/i.test(output) && !/Signer #\d+ certificate DN:/i.test(output)) {
      failures.push('APK 未返回可验证的 Android 签名证书')
      return
    }
    if (releaseCandidate && /Android Debug/i.test(output)) {
      failures.push('正式候选 APK 使用了 Android Debug 证书')
    }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split('\n').slice(-3).join(' ')
    failures.push(`APK 签名验证失败${detail ? `：${detail}` : ''}`)
  }
}

function verifyAabSignature(file, failures) {
  try {
    const output = commandOutput('jarsigner', ['-verify', '-strict', '-verbose', '-certs', file])
    if (!/jar verified\./i.test(output)) {
      failures.push('AAB 未通过 JAR/上传密钥签名验证')
      return
    }
    if (/Android Debug/i.test(output)) {
      failures.push('正式候选 AAB 使用了 Android Debug 证书')
    }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split('\n').slice(-3).join(' ')
    failures.push(`AAB 签名验证失败${detail ? `：${detail}` : ''}`)
  }
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
  const isAab = name.toLowerCase().endsWith('.aab')
  const budget = isApk ? APK_BUDGET : AAB_BUDGET
  const failures = []

  if (!isApk && !isAab) failures.push('只允许验证 .apk 或 .aab Android 包')
  if (/(^|[-_.])debug([-_. ]|$)/i.test(name)) failures.push('文件名包含 debug')
  if (bytes > budget) failures.push(`包体 ${(bytes / MB).toFixed(1)} MB > ${(budget / MB).toFixed(1)} MB`)
  if (nativeBytes > NATIVE_BUDGET) failures.push(`最大 native .so ${(nativeBytes / MB).toFixed(1)} MB > ${(NATIVE_BUDGET / MB).toFixed(1)} MB`)

  if (isApk) verifyApkSignature(file, failures)
  if (isAab) verifyAabSignature(file, failures)

  const mode = releaseCandidate ? 'release-candidate' : 'smoke'
  console.log(`[android-package] ${name}: ${(bytes / MB).toFixed(1)} MB; largest native .so ${(nativeBytes / MB).toFixed(1)} MB; mode=${mode}`)
  for (const failure of failures) console.error(`[android-package] FAIL ${name}: ${failure}`)
  return failures.length
}

const failures = inputs.reduce((count, file) => count + inspect(file), 0)
if (failures > 0) process.exit(1)
console.log(`[android-package] ${releaseCandidate ? 'signed release candidate' : 'smoke package'} checks pass.`)
