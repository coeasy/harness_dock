import path from 'node:path'
import { defaultHostUserDataDir } from '../../../packages/bootstrap/src/index.ts'

export function resourceRoot(
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HARNESSDOCK_RESOURCE_DIR) return path.resolve(env.HARNESSDOCK_RESOURCE_DIR)

  const exeDir = path.dirname(execPath)
  if (
    platform === 'darwin' &&
    path.basename(exeDir) === 'MacOS' &&
    path.basename(path.dirname(exeDir)) === 'Contents'
  ) {
    return path.resolve(exeDir, '..', 'Resources')
  }
  return path.join(exeDir, 'resources')
}

export function originPath(root = resourceRoot()): string {
  return path.join(root, 'origin.json')
}

export function pluginPath(root = resourceRoot()): string {
  return path.join(root, 'plugin-embedded-client', 'index.js')
}

export function bundledRoot(root = resourceRoot()): string {
  return path.join(root, 'dsh-runtime')
}

export function iconPath(root = resourceRoot()): string {
  return path.join(root, 'icon-256.png')
}

export function perryUserDataDir(): string {
  return defaultHostUserDataDir('perry')
}
