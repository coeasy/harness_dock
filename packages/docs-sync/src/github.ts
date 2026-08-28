import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitTagToVersion } from './versions.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_GITHUB_API = 'https://api.github.com'
const DEFAULT_DOCS_RAW = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness'
const USER_AGENT = 'dsh-client-docs-sync'
const GIT_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git'

export interface GitHubTagRef {
  ref: string
  object: { sha: string; type: string }
}

export interface DshTag {
  version: string
  sha: string
  tag: string
}

export function parseGitLsRemote(stdout: string): DshTag[] {
  const byTag = new Map<string, DshTag>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([0-9a-f]+)\s+refs\/tags\/(\S+)$/.exec(line.trim())
    if (!match) continue
    const sha = match[1]!
    let tag = match[2]!
    const peeled = tag.endsWith('^{}')
    if (peeled) tag = tag.slice(0, -3)
    const version = gitTagToVersion(tag)
    if (!version) continue
    const current = byTag.get(tag)
    if (!current || peeled) {
      byTag.set(tag, { tag, version, sha })
    }
  }
  return [...byTag.values()]
}

export async function listDshGitTags(
  fetchImpl: typeof fetch = fetch,
  apiBase = DEFAULT_GITHUB_API,
): Promise<DshTag[]> {
  if (fetchImpl === fetch) {
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--tags', GIT_REMOTE], {
        windowsHide: true,
      })
      const tags = parseGitLsRemote(stdout)
      if (tags.length > 0) return tags
    } catch {
      // fall through to the API
    }
  }
  return listTagsViaApi(fetchImpl, apiBase)
}

async function listTagsViaApi(
  fetchImpl: typeof fetch,
  apiBase: string,
): Promise<DshTag[]> {
  const tags: DshTag[] = []
  let url: string | null =
    `${apiBase}/repos/deepseek-ai/deepseek-harness/git/matching-refs/tags/dsh-v`
  while (url) {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
    })
    if (!response.ok) {
      throw new Error(`GitHub tags failed: ${response.status} ${await response.text()}`)
    }
    const body = (await response.json()) as GitHubTagRef[]
    for (const item of body) {
      const tag = item.ref.replace('refs/tags/', '')
      const version = gitTagToVersion(tag)
      if (!version) continue
      tags.push({ version, sha: item.object.sha, tag })
    }
    url = nextLink(response.headers.get('link'))
  }
  return tags
}

export async function fetchGuideDocs(
  gitTag: string,
  fetchImpl: typeof fetch = fetch,
  rawBase = DEFAULT_DOCS_RAW,
): Promise<Record<string, string>> {
  const paths = [
    'docs/user/guide/index.md',
    'docs/user/guide/index.zh.md',
    'docs/user/guide/providers.md',
    'docs/user/guide/providers.zh.md',
  ]
  const files: Record<string, string> = {}
  for (const path of paths) {
    const response = await fetchImpl(`${rawBase}/${gitTag}/${path}`, {
      headers: { 'user-agent': USER_AGENT },
    })
    if (response.status === 404) continue
    if (!response.ok) {
      throw new Error(`Fetch ${path} @ ${gitTag} failed: ${response.status}`)
    }
    files[path] = await response.text()
  }
  if (!files['docs/user/guide/index.zh.md'] && !files['docs/user/guide/index.md']) {
    throw new Error(`No user guide found at tag ${gitTag}`)
  }
  return files
}

function nextLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (match) return match[1] ?? null
  }
  return null
}
