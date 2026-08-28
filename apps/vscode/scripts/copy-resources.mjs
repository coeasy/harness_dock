import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '../..')
const dest = path.join(root, 'resources')
mkdirSync(path.join(dest, 'plugin-embedded-client'), { recursive: true })
cpSync(
  path.join(repo, 'packages/plugin-embedded-client/lib/index.js'),
  path.join(dest, 'plugin-embedded-client/index.js'),
)
cpSync(path.join(repo, 'packages/docs-sync/origin.json'), path.join(dest, 'origin.json'))
