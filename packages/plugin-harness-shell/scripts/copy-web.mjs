import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(path.join(packageRoot, 'web'), { recursive: true })
await cp(path.join(packageRoot, 'src', 'web', 'shell.js'), path.join(packageRoot, 'web', 'shell.js'))
