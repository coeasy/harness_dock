#!/usr/bin/env node
/**
 * Lightweight boot-duration report from the desktop boot log (scheme F2).
 *
 * Finds the "boot start" and "boot ok" / "boot FAILED" lines, which carry
 * `[ISO]` timestamps, and prints the wall-clock difference:
 *
 *   boot duration: 5165 ms
 *
 * Log resolution order (first existing file wins):
 *   1. CLI argument:        node scripts/perf-report.mjs <logFile>
 *   2. env DSH_BOOT_LOG:    DSH_BOOT_LOG=<logFile> node scripts/perf-report.mjs
 *   3. default temp dir:    <os.tmpdir()>/harnessdock-logs/boot-YYYY-MM-DD.log
 *   4. newest boot-*.log found under os.tmpdir()/harnessdock-logs or the app
 *      log dirs (%LOCALAPPDATA%/<app>/logs, %APPDATA%/<app>/logs).
 *
 * Best-effort by design: if no log is found, or the log lacks both markers,
 * a hint is printed and the exit code is 0 (never fails a pipeline).
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TS_RE = /\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/

const APP_LOG_DIRS = ['HarnessDock', 'harnessdock', 'com.dsh.client', 'dsh']
  .flatMap((app) => {
    const dirs = []
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    dirs.push(path.join(local, app, 'logs'))
    dirs.push(path.join(roaming, app, 'logs'))
    return dirs
  })

function todayName() {
  return new Date().toISOString().slice(0, 10)
}

async function newestBootLog(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const boots = []
  for (const name of entries) {
    if (!/^boot-.*\.log$/i.test(name)) continue
    const full = path.join(dir, name)
    try {
      const info = await stat(full)
      if (info.isFile()) boots.push({ full, mtimeMs: info.mtimeMs })
    } catch {
      // skip unreadable
    }
  }
  if (boots.length === 0) return null
  boots.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return boots[0].full
}

async function resolveLogFile() {
  const cli = process.argv[2]
  const envLog = process.env.DSH_BOOT_LOG
  const explicit = []
  if (cli) explicit.push(cli)
  if (envLog) explicit.push(envLog)
  explicit.push(path.join(os.tmpdir(), 'harnessdock-logs', `boot-${todayName()}.log`))
  for (const candidate of explicit) {
    if (!candidate) continue
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  const scanDirs = [path.join(os.tmpdir(), 'harnessdock-logs'), ...APP_LOG_DIRS]
  for (const dir of scanDirs) {
    const found = await newestBootLog(dir)
    if (found) return found
  }
  return null
}

const logFile = await resolveLogFile()
if (!logFile) {
  console.log(
    '[perf:report] no boot log found — nothing to report (best-effort).\n' +
      `Expected at ${path.join(os.tmpdir(), 'harnessdock-logs', `boot-${todayName()}.log`)} ` +
      'or via DSH_BOOT_LOG / CLI arg.',
  )
  process.exit(0)
}

const lines = (await readFile(logFile, 'utf8')).split(/\r?\n/)
let startTs = null
let endTs = null
for (const line of lines) {
  const match = TS_RE.exec(line)
  if (!match) continue
  const iso = match[1]
  if (!startTs && /\bboot start\b/i.test(line)) {
    startTs = iso
  }
  if (/\bboot (ok|FAILED)\b/i.test(line)) {
    endTs = iso
  }
}

if (!startTs || !endTs) {
  console.log(
    `[perf:report] ${logFile} has no matching "boot start" + "boot ok"/"boot FAILED" ` +
      'lines — nothing to report (best-effort).',
  )
  process.exit(0)
}

const durationMs = Date.parse(endTs) - Date.parse(startTs)
console.log(`boot duration: ${durationMs} ms`)
console.log(`  log: ${logFile}`)
console.log(`  start: ${startTs}`)
console.log(`  end:   ${endTs}`)
process.exit(0)
