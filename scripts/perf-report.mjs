#!/usr/bin/env node
/**
 * Best-effort report for native Tauri startup traces.
 *
 * Trace lines are emitted by `startup_trace.rs` and intentionally contain only
 * elapsed milliseconds plus a stable phase name:
 *
 *   [+0ms] phase=process_started
 *   [+124ms] phase=runtime_start
 *   [+1682ms] phase=runtime_ready
 *   [+1715ms] phase=webview_requested
 *
 * Resolution order:
 *   1. CLI argument
 *   2. HARNESSDOCK_STARTUP_TRACE
 *   3. legacy DSH_BOOT_LOG override
 *   4. newest startup-*.log under <os.tmpdir()>/harnessdock-logs
 *
 * Missing or incomplete traces never fail a pipeline.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TRACE_RE = /^\[\+(\d+)ms\]\s+phase=([a-z0-9_-]+)\s*$/i
const TRACE_DIR = path.join(os.tmpdir(), 'harnessdock-logs')

async function newestStartupLog(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const traces = []
  for (const name of entries) {
    if (!/^startup-.*\.log$/i.test(name)) continue
    const full = path.join(dir, name)
    try {
      const info = await stat(full)
      if (info.isFile()) traces.push({ full, mtimeMs: info.mtimeMs })
    } catch {
      // Ignore unreadable best-effort traces.
    }
  }
  traces.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return traces[0]?.full ?? null
}

async function existingFile(candidate) {
  if (!candidate) return null
  try {
    return (await stat(candidate)).isFile() ? candidate : null
  } catch {
    return null
  }
}

async function resolveTraceFile() {
  for (const candidate of [
    process.argv[2],
    process.env.HARNESSDOCK_STARTUP_TRACE,
    process.env.DSH_BOOT_LOG,
  ]) {
    const found = await existingFile(candidate)
    if (found) return found
  }
  return newestStartupLog(TRACE_DIR)
}

const traceFile = await resolveTraceFile()
if (!traceFile) {
  console.log(
    '[perf:report] no native startup trace found — nothing to report (best-effort).\n' +
      `Expected startup-*.log under ${TRACE_DIR} or an explicit CLI/HARNESSDOCK_STARTUP_TRACE path.`,
  )
  process.exit(0)
}

const phases = new Map()
for (const line of (await readFile(traceFile, 'utf8')).split(/\r?\n/)) {
  const match = TRACE_RE.exec(line)
  if (!match) continue
  const elapsedMs = Number(match[1])
  const phase = match[2].toLowerCase()
  if (!Number.isFinite(elapsedMs) || phases.has(phase)) continue
  phases.set(phase, elapsedMs)
}

if (phases.size === 0) {
  console.log(
    `[perf:report] ${traceFile} has no native startup phase markers — nothing to report (best-effort).`,
  )
  process.exit(0)
}

const preferredTerminal = [
  'primary_visible',
  'recovery',
  'webview_requested',
  'runtime_ready',
  'runtime_start',
  'process_started',
].find((phase) => phases.has(phase))
const terminalMs = phases.get(preferredTerminal) ?? Math.max(...phases.values())

console.log(`startup duration: ${terminalMs} ms`)
console.log(`  terminal: ${preferredTerminal ?? 'latest_phase'}`)
console.log(`  trace: ${traceFile}`)

const ordered = [...phases.entries()].sort((a, b) => a[1] - b[1])
let previous = 0
for (const [phase, elapsedMs] of ordered) {
  console.log(`  ${phase}: +${elapsedMs} ms (delta ${elapsedMs - previous} ms)`)
  previous = elapsedMs
}

process.exit(0)
