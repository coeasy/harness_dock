import path from 'node:path'
import { defaultHostUserDataDir } from '../../../packages/bootstrap/src/index.ts'

export function resourceRoot(
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HARNESSDOCK_RESOURCE_DIR) return path.resolve(env.HARNESSDOCK_RESOURCE_DIR)

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const exeDir = pathApi.dirname(execPath)
  if (
    platform === 'darwin' &&
    pathApi.basename(exeDir) === 'MacOS' &&
    pathApi.basename(pathApi.dirname(exeDir)) === 'Contents'
  ) {
    return pathApi.resolve(exeDir, '..', 'Resources')
  }
  return pathApi.join(exeDir, 'resources')
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
