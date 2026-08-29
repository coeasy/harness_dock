import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PI_AI_MANIFEST = path.join(
  '@earendil-works',
  'pi-ai',
  'dist',
  'providers',
  'data',
  '.manifest.json',
)

function modulePath(runtimeDir: string, packageName: string): string {
  return path.join(runtimeDir, 'node_modules', ...packageName.split('/'))
}

export function requiredNativePackages(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const supported = arch === 'x64' || arch === 'arm64'
  if (!supported) {
    throw new Error(`unsupported bundled-runtime architecture: ${arch}`)
  }

  if (platform === 'win32') {
    return [
      `node-addon-require-builtin-win32-${arch}-msvc`,
      `@koromix/koffi-win32-${arch}`,
      `@img/sharp-win32-${arch}`,
    ]
  }
  if (platform === 'darwin') {
    return [
      `node-addon-require-builtin-darwin-${arch}`,
      `@koromix/koffi-darwin-${arch}`,
      `@img/sharp-darwin-${arch}`,
    ]
  }
  if (platform === 'linux') {
    return [
      `node-addon-require-builtin-linux-${arch}-gnu`,
      `@koromix/koffi-linux-${arch}`,
      `@img/sharp-linux-${arch}`,
    ]
  }
  throw new Error(`unsupported bundled-runtime platform: ${platform}`)
}

/**
 * pi-ai 0.82.1 references a hidden generated manifest that its npm tarball
 * does not contain. The only runtime consumer reads generatedAt, so restore a
 * deterministic compatibility manifest until the pinned dsh dependency moves
 * to a corrected pi-ai release.
 */
export async function repairKnownRuntimeAssets(runtimeDir: string): Promise<string[]> {
  const dataDir = path.join(
    runtimeDir,
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data',
  )
  const manifest = path.join(dataDir, '.manifest.json')
  try {
    await access(manifest)
    return []
  } catch {
    // Continue only when pi-ai itself is installed. Missing pi-ai is reported
    // by assertBundledRuntimeIntegrity instead of being hidden by this repair.
  }

  const packageFile = path.join(
    runtimeDir,
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'package.json',
  )
  let version = ''
  try {
    const pkg = JSON.parse(await readFile(packageFile, 'utf8')) as { version?: unknown }
    version = typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return []
  }
  if (version !== '0.82.1') return []

  await mkdir(dataDir, { recursive: true })
  await writeFile(
    manifest,
    `${JSON.stringify({
      generatedAt: '2026-08-26T00:00:00.000Z',
      repairedBy: 'HarnessDock',
      sourcePackage: `@earendil-works/pi-ai@${version}`,
    }, null, 2)}\n`,
    'utf8',
  )
  return [PI_AI_MANIFEST]
}

export async function assertBundledRuntimeIntegrity(
  runtimeDir: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<void> {
  const required = [
    '@deepseek-ai/dsh',
    '@earendil-works/pi-ai',
    ...requiredNativePackages(platform, arch),
  ]
  const missing: string[] = []
  for (const packageName of required) {
    try {
      await access(path.join(modulePath(runtimeDir, packageName), 'package.json'))
    } catch {
      missing.push(packageName)
    }
  }
  try {
    await access(path.join(runtimeDir, 'node_modules', PI_AI_MANIFEST))
  } catch {
    missing.push(PI_AI_MANIFEST)
  }
  if (missing.length > 0) {
    throw new Error(
      `bundled runtime is incomplete for ${platform}/${arch}; missing: ${missing.join(', ')}`,
    )
  }
}
