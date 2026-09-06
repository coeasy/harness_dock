import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rustSource } from './rust-source.ts'

/**
 * Locks the loopback validation boundary that decides whether a Gateway URL may
 * speak plain HTTP.
 *
 * The bug this file guards against: `url::Url::host_str()` returns the host
 * exactly as written in the authority, so an IPv6 loopback arrives as `[::1]`
 * rather than `::1`. The shared `util::is_loopback` used to assume callers had
 * already stripped the brackets, which made a legitimately local Gateway
 * (`http://[::1]:8080`) look like remote HTTP and get rejected.
 *
 * The second half of the contract is that the fix stays in one place. Two
 * consumers (the remote Gateway client and the host-embedded Gateway) needed the
 * same definition, and `gateway.rs` kept a private copy that drifted until R1
 * was extended to cover it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rustRoot = path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'src')

function readRustFiles(directory: string): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...readRustFiles(full))
    } else if (entry.name.endsWith('.rs')) {
      files.push({
        file: path.relative(rustRoot, full).split(path.sep).join('/'),
        text: readFileSync(full, 'utf8').replace(/\r\n/g, '\n'),
      })
    }
  }
  return files
}

const allRust = readRustFiles(rustRoot)
const DEFINITION = /fn\s+is_loopback\s*\(/g

describe('loopback validation contract', () => {
  it('keeps exactly one is_loopback implementation, in util.rs', () => {
    const definitions = allRust
      .map(({ file, text }) => ({ file, matches: [...text.matchAll(DEFINITION)].length }))
      .filter((entry) => entry.matches > 0)

    expect(definitions).toEqual([{ file: 'util.rs', matches: 1 }])
  })

  it('accepts the bracketed IPv6 form that Url::host_str() returns', () => {
    const util = rustSource(repoRoot, 'apps/tauri/src-tauri/src/util.rs')

    // The host string is trimmed and unbracketed before the localhost check and
    // the IpAddr parse; both branches must read the unbracketed value.
    expect(util).toContain('let host = host.trim()')
    expect(util).toContain("host.starts_with('[') && host.ends_with(']')")
    expect(util).toMatch(/let\s+unbracketed\s*=/)
    expect(util).toContain('unbracketed.eq_ignore_ascii_case("localhost")')
    expect(util).toMatch(/unbracketed\s*\n\s*\.parse::<IpAddr>\(\)/)

    // The unit tests must keep pinning the bracketed form as loopback, otherwise
    // the behaviour can regress without any Rust-side signal.
    expect(util).toContain('assert!(is_loopback("[::1]"))')
    expect(util).toContain('assert!(is_loopback("::1"))')
    expect(util).toContain('assert!(is_loopback("127.7.7.7"))')
  })

  it('never treats a bracketed non-loopback address as local', () => {
    const util = rustSource(repoRoot, 'apps/tauri/src-tauri/src/util.rs')
    expect(util).toContain('assert!(!is_loopback("[192.168.1.1]"))')
    expect(util).toContain('assert!(!is_loopback("[::ffff:10.0.0.1]"))')
  })

  it('routes both Gateway consumers through the shared helper', () => {
    const remote = rustSource(repoRoot, 'apps/tauri/src-tauri/src/gateway.rs')
    const hostEmbedded = rustSource(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs')

    expect(remote).toContain('use crate::util::is_loopback;')
    expect(remote).toContain('is_loopback(host)')
    expect(remote).toContain('host_str().is_some_and(is_loopback)')

    expect(hostEmbedded).toContain('use crate::util::{is_loopback, rfc3339}')
    expect(hostEmbedded).toContain('is_loopback(host)')
  })

  it('still enforces the HTTP-means-loopback-only rule at both sites', () => {
    const remote = rustSource(repoRoot, 'apps/tauri/src-tauri/src/gateway.rs')
    const hostEmbedded = rustSource(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs')

    expect(remote).toContain('url.scheme() == "http" && is_loopback(host)')
    expect(remote).toContain('远程 Gateway 必须使用 HTTPS')
    expect(hostEmbedded).toContain('url.scheme() == "http" && is_loopback(host)')
    expect(hostEmbedded).toContain('Gateway 公网地址必须使用 HTTPS')
  })

  it('covers the IPv6 authority through the public Gateway entrypoint', () => {
    const remote = rustSource(repoRoot, 'apps/tauri/src-tauri/src/gateway.rs')
    // The regression was visible end to end: this input must be accepted.
    expect(remote).toContain('"http://[::1]:8080"')
    expect(remote).toContain('loopback HTTP origin must be accepted')
    // And plain-HTTP public addresses must still be rejected.
    expect(remote).toContain('normalize_gateway_origin("http://gateway.example.com").is_err()')
    expect(remote).toContain('normalize_gateway_origin("http://0.0.0.0:8080").is_err()')
    expect(remote).toContain('normalize_gateway_origin("https://gateway.example.com").is_ok()')
  })
})
