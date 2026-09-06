import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface RuntimeBinding {
  generation: number
  nonce: string
  imageIdentity: string
}

export interface RuntimeBindingInput {
  generation: number
  runtimeRoot?: string
  dshVersion: string
  command: string
  argsPrefix: readonly string[]
}

/**
 * Build a per-start trust binding for the Node/VS Code host.
 *
 * Sealed Runtime images already carry the canonical sha256-v1 identity in
 * manifest.json; use it whenever available. Local/development runtimes do not
 * have a sealed manifest, so bind the start to the selected executable tuple
 * plus a cryptographically random nonce. The nonce remains the anti-replay
 * boundary in both cases.
 */
export async function createRuntimeBinding(input: RuntimeBindingInput): Promise<RuntimeBinding> {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new Error(`invalid Runtime generation: ${input.generation}`)
  }
  const nonce = randomBytes(32).toString('hex')
  const imageIdentity =
    (await readManifestIdentity(input.runtimeRoot)) ?? fallbackIdentity(input)
  return { generation: input.generation, nonce, imageIdentity }
}

async function readManifestIdentity(runtimeRoot: string | undefined): Promise<string | undefined> {
  if (!runtimeRoot) return undefined
  try {
    const manifest = JSON.parse(
      await readFile(path.join(runtimeRoot, 'manifest.json'), 'utf8'),
    ) as { imageIdentity?: unknown }
    if (
      typeof manifest.imageIdentity === 'string' &&
      /^sha256:[0-9a-f]{64}$/i.test(manifest.imageIdentity)
    ) {
      return manifest.imageIdentity
    }
  } catch {
    // Local/development runtimes legitimately have no sealed manifest.
  }
  return undefined
}

function fallbackIdentity(input: RuntimeBindingInput): string {
  const digest = createHash('sha256')
    .update('harnessdock-node-host-binding-v1\0')
    .update(input.dshVersion)
    .update('\0')
    .update(path.resolve(input.command))
    .update('\0')
    .update(input.argsPrefix.join('\0'))
    .digest('hex')
  return `sha256:${digest}`
}
