import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const contract = JSON.parse(await readFile(path.join(repoRoot, 'protocol', 'shell-contract.json'), 'utf8'))
const source = await readFile(path.join(packageRoot, 'src', 'web', 'shell.js'), 'utf8')
const rendered = source
  .replaceAll('__SHELL_API_VERSION__', String(contract.apiVersion))
  .replaceAll('__SHELL_PLUGIN_ID__', JSON.stringify(contract.pluginId))

if (rendered.includes('__SHELL_')) throw new Error('unresolved shell contract placeholder in web asset')
await mkdir(path.join(packageRoot, 'web'), { recursive: true })
await writeFile(path.join(packageRoot, 'web', 'shell.js'), rendered, 'utf8')
