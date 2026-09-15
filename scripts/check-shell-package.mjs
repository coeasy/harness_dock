#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages', 'plugin-harness-shell')
const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts']
const npmCandidates = buildNpmCandidates(process.execPath)
let packed
let lastError = null
for (const candidate of npmCandidates) {
  try {
    const output = execFileSync(candidate.command, candidate.args, {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    packed = JSON.parse(output)?.[0]
    lastError = null
  } catch (error) {
    lastError = error
  }
  if (packed) break
}
if (!packed) {
  throw new Error(
    `npm pack could not run. Tried: ${npmCandidates.map((entry) => entry.label).join(', ')} ` +
      `— last error: ${lastError?.code ?? lastError?.message}`,
  )
}
if (!packed) throw new Error('npm pack --dry-run did not return a package description')
if (packed.name !== '@dsh/plugin-harness-shell') throw new Error(`unexpected package name: ${packed.name}`)
if (packed.version !== packageJson.version) throw new Error(`package version drift: ${packed.version} != ${packageJson.version}`)
const files = new Set((packed.files ?? []).map((file) => file.path))
for (const required of ['package.json', 'manifest.json', 'lib/index.js', 'web/shell.js']) {
  if (!files.has(required)) throw new Error(`publishable Harness Shell is missing ${required}`)
}
for (const file of files) {
  if (file.startsWith('node_modules/') || file.includes('/node_modules/')) throw new Error(`node_modules leaked into shell package: ${file}`)
  if (file.includes('src-tauri/') || /\.(exe|dmg|appimage|deb|aab|apk)$/i.test(file)) throw new Error(`host binary leaked into shell package: ${file}`)
}
if (!Number.isFinite(packed.size) || packed.size <= 0 || packed.size > 512 * 1024) {
  throw new Error(`unexpected Harness Shell packed size: ${packed.size}`)
}

// Bridge API version lockstep: the shipped BRIDGE_SCRIPT must agree with the
// TypeScript shell contract (`SHELL_API_VERSION`). A drift here means the
// frontend capability gate and the injected bridge disagree about which
// commands a Harness Web document may invoke.
const bridgeScript = readFileSync(
  path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'src', 'harness_shell.rs'),
  'utf8',
)
const shellContract = readFileSync(
  path.join(repoRoot, 'packages', 'bootstrap', 'src', 'shell-contract.ts'),
  'utf8',
)
// The plugin entrypoint declares its own `apiVersion`. It used to be a third,
// unwatched copy: `check-shell-package.mjs` only compared the bridge against
// the contract, so `src/index.ts` silently stayed on 1 while the other two
// moved to 2. Include it so all three sources must agree.
const pluginEntry = readFileSync(path.join(packageDir, 'src', 'index.ts'), 'utf8')
const bridgeApiVersion = bridgeScript.match(/apiVersion:\s*(\d+)/)?.[1]
const contractApiVersion = shellContract.match(/SHELL_API_VERSION\s*=\s*(\d+)\s*as\s+const/)?.[1]
const entryApiVersion = pluginEntry.match(/export const apiVersion = (\d+) as const/)?.[1]
if (!bridgeApiVersion || !contractApiVersion || !entryApiVersion) {
  throw new Error(
    'could not locate all three shell apiVersion declarations ' +
      '(harness_shell.rs BRIDGE_SCRIPT, shell-contract.ts SHELL_API_VERSION, plugin-harness-shell/src/index.ts)',
  )
}
const apiVersions = { bridge: bridgeApiVersion, contract: contractApiVersion, entry: entryApiVersion }
const distinctApiVersions = new Set(Object.values(apiVersions))
if (distinctApiVersions.size !== 1) {
  throw new Error(
    `Shell bridge API version drift: ${JSON.stringify(apiVersions)} ` +
      '(BRIDGE_SCRIPT / SHELL_API_VERSION / plugin entrypoint must all be equal)',
  )
}

// The plugin entrypoint also advertises a capability list. It must be exactly
// the contract's command set — an extra name advertises a command the host may
// not accept, and a missing one hides a command the host does expose.
// Command names are dotted paths with two or more segments, e.g.
// `window.minimize` and `app.update.install`; the segment regex must accept
// more than one dot or multi-word commands get silently dropped.
const COMMAND_NAME = "'([a-z]+(?:\\.[A-Za-z-]+)+)'"
const entryCapabilities = [...pluginEntry.matchAll(new RegExp(COMMAND_NAME, 'g'))].map((match) => match[1])
const contractCommands = [
  ...shellContract.matchAll(new RegExp(`^ {2}${COMMAND_NAME},?$`, 'gm')),
].map((match) => match[1])
const entrySet = new Set(entryCapabilities)
const contractSet = new Set(contractCommands)
const missingFromEntry = contractCommands.filter((command) => !entrySet.has(command))
const extraInEntry = entryCapabilities.filter((command) => !contractSet.has(command))
if (contractCommands.length === 0) {
  throw new Error('could not parse SHELL_COMMANDS from shell-contract.ts')
}
if (missingFromEntry.length > 0 || extraInEntry.length > 0) {
  throw new Error(
    `Shell command list drift: missing in plugin entrypoint [${missingFromEntry.join(', ')}], ` +
      `extra in plugin entrypoint [${extraInEntry.join(', ')}]`,
  )
}

console.log(
  `[shell-package] ${packed.name}@${packed.version}: ${packed.size} bytes, ${files.size} files; ` +
    `bridge apiVersion ${bridgeApiVersion} matches SHELL_API_VERSION ${contractApiVersion} ` +
    `and plugin entrypoint ${entryApiVersion}; ${contractCommands.length} commands aligned; publish contract passes.`,
)

/**
 * `spawnSync` cannot launch `npm` reliably across hosts: it does not apply
 * PATHEXT, so the bare `npm` name only resolves on POSIX (where the launcher is
 * an executable script), and on Windows the launcher is `npm.cmd`, which Node
 * will not spawn directly (`EINVAL`). Resolve npm's own JavaScript entrypoint
 * next to the running Node binary and drive it with `node` instead — portable
 * and free of shell-launcher assumptions. The launcher names are kept as a
 * fallback for hosts (e.g. CI images with a pnpm-shimmed `npm`) where npm is not
 * installed alongside Node.
 */
function buildNpmCandidates(nodePath) {
  const candidates = []
  const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    candidates.push({ label: `node ${npmCli}`, command: nodePath, args: [npmCli, ...npmArgs] })
  }
  candidates.push({ label: 'npm', command: 'npm', args: [...npmArgs] })
  if (process.platform === 'win32') {
    candidates.push({ label: 'npm.cmd', command: 'npm.cmd', args: [...npmArgs] })
  }
  return candidates
}
