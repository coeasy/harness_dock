import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Keep the Runtime package manager aligned with the pinned DeepSeek Harness
// build/profile toolchain, not with the HarnessDock repository's own pnpm.
export const PNPM_BUNDLE_VERSION = '11.7.0'
export const PNPM_BUNDLE_SHA256 = 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee'

export function bundledPnpmPackageDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'tools', 'pnpm', 'node_modules', 'pnpm')
}

export function bundledPnpmEntry(runtimeRoot: string): string {
  return path.join(bundledPnpmPackageDir(runtimeRoot), 'bin', 'pnpm.cjs')
}

export function bundledPnpmShim(runtimeRoot: string, platform: NodeJS.Platform): string {
  return path.join(runtimeRoot, 'tools', 'bin', platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
}

export async function writeBundledPnpmShim(
  runtimeRoot: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const binDir = path.join(runtimeRoot, 'tools', 'bin')
  await mkdir(binDir, { recursive: true })
  const shim = bundledPnpmShim(runtimeRoot, platform)
  if (platform === 'win32') {
    await writeFile(
      shim,
      '@ECHO OFF\r\n"%~dp0\\..\\..\\node.exe" "%~dp0\\..\\pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n',
      'utf8',
    )
  } else {
    await writeFile(
      shim,
      '#!/bin/sh\nSCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$SCRIPT_DIR/../../bin/node" "$SCRIPT_DIR/../pnpm/node_modules/pnpm/bin/pnpm.cjs" "$@"\n',
      'utf8',
    )
    await chmod(shim, 0o755)
  }
  return shim
}

export async function assertBundledPnpm(
  runtimeRoot: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const packageFile = path.join(bundledPnpmPackageDir(runtimeRoot), 'package.json')
  let version = ''
  try {
    const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as { version?: unknown }
    version = typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    throw new Error(`bundled pnpm package missing: ${packageFile}`)
  }
  if (version !== PNPM_BUNDLE_VERSION) {
    throw new Error(`bundled pnpm version ${version || 'unknown'} != pinned ${PNPM_BUNDLE_VERSION}`)
  }
  await access(bundledPnpmEntry(runtimeRoot))
  await access(bundledPnpmShim(runtimeRoot, platform))
}
