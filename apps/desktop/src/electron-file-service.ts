import { app, dialog, net, session, shell, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  DownloadFileInput,
  DownloadFileResult,
  FilePickerOptions,
  FileService,
  SaveFileOptions,
  UploadFileInput,
  UploadFileResult,
} from '@dsh/bootstrap/client-core'
import { appState } from './state.ts'
import { sanitizeDownloadFilename, suggestedDownloadPath } from './downloads.ts'
import { canonicalDestinationPath, canonicalExistingPath } from './workspace-path.ts'

function ownerWindow(): BrowserWindow | undefined {
  const window = appState.mainWindow
  if (!window || window.isDestroyed()) return undefined
  return window
}

function fileFilters(
  filters: FilePickerOptions['filters'] | SaveFileOptions['filters'],
): Electron.FileFilter[] | undefined {
  if (!filters?.length) return undefined
  return filters.map((filter) => ({ name: filter.name, extensions: [...filter.extensions] }))
}

function safeTransferHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (lower === 'cookie' || lower === 'authorization' || lower === 'proxy-authorization' || lower === 'host') {
      throw new Error(`Sensitive transfer header must be provided by the native session, not FileService: ${name}`)
    }
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid transfer header: ${name}`)
    }
    safe[name] = value
  }
  return safe
}

function trustedTransferUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) file transfers are supported')
  const allowed = new Set<string>()
  if (appState.runtimeEndpoint) allowed.add(new URL(appState.runtimeEndpoint).origin)
  if (appState.gateway) {
    allowed.add(new URL(appState.gateway.localUrl).origin)
    allowed.add(new URL(appState.gateway.publicUrl).origin)
  }
  if (!allowed.has(url.origin)) throw new Error(`File transfer origin is not trusted: ${url.origin}`)
  return url
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadOnce(
  input: DownloadFileInput,
  destination: string,
  partial: string,
): Promise<{ bytes: number; resumed: boolean }> {
  const resumeFrom = input.resume === false
    ? 0
    : await stat(partial).then((value) => value.size, () => 0)
  const headers = safeTransferHeaders(input.headers)
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`
  const response = await net.fetch(trustedTransferUrl(input.url).toString(), {
    method: 'GET',
    headers,
    signal: input.signal,
    redirect: 'manual',
  })
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Download redirect was blocked; callers must use an explicitly trusted final origin')
  }
  const resumed = resumeFrom > 0 && response.status === 206
  if (!response.ok && response.status !== 206) throw new Error(`Download failed with HTTP ${response.status}`)
  if (!response.body) throw new Error('Download response did not contain a body')

  if (resumeFrom > 0 && !resumed) await rm(partial, { force: true })
  const initial = resumed ? resumeFrom : 0
  const totalHeader = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  const total = Number.isFinite(totalHeader) ? initial + totalHeader : undefined
  let transferred = initial
  const writer = createWriteStream(partial, { flags: resumed ? 'a' : 'w', mode: 0o600 })
  const reader = response.body.getReader()
  try {
    while (true) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Download aborted')
      const result = await reader.read()
      if (result.done) break
      const chunk = Buffer.from(result.value)
      if (!writer.write(chunk)) await new Promise<void>((resolve) => writer.once('drain', resolve))
      transferred += chunk.length
      input.onProgress?.({ transferredBytes: transferred, ...(total === undefined ? {} : { totalBytes: total }) })
    }
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject)
      writer.end(resolve)
    })
  } catch (error) {
    writer.destroy()
    await reader.cancel().catch(() => undefined)
    throw error
  }
  await rename(partial, destination)
  return { bytes: transferred, resumed }
}

async function downloadFile(input: DownloadFileInput): Promise<DownloadFileResult> {
  const url = trustedTransferUrl(input.url)
  const fallbackName = path.basename(url.pathname) || 'download.bin'
  let destination: string
  if (input.destination) {
    destination = await canonicalDestinationPath(input.destination, input.workspaceRoot)
    await mkdir(path.dirname(destination), { recursive: true })
  } else {
    const downloads = app.getPath('downloads')
    destination = suggestedDownloadPath(downloads, input.suggestedName || fallbackName)
  }
  const partial = `${destination}.part`

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const transfer = await downloadOnce(input, destination, partial)
      const digest = await sha256File(destination)
      if (input.expectedSha256 && digest.toLowerCase() !== input.expectedSha256.toLowerCase()) {
        await rm(destination, { force: true })
        throw new Error(`Downloaded file sha256 mismatch: expected ${input.expectedSha256}, got ${digest}`)
      }
      return { path: destination, bytes: transfer.bytes, sha256: digest, resumed: transfer.resumed }
    } catch (error) {
      lastError = error
      if (input.signal?.aborted || input.resume === false || attempt === 1) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function uploadFile(input: UploadFileInput): Promise<UploadFileResult> {
  const source = await canonicalExistingPath(input.sourcePath, input.workspaceRoot)
  const info = await stat(source)
  if (!info.isFile()) throw new Error('Upload source must be a regular file')
  const url = trustedTransferUrl(input.destinationUrl)
  const headers = safeTransferHeaders(input.headers)
  headers['content-length'] = String(info.size)

  return new Promise<UploadFileResult>((resolve, reject) => {
    const request = net.request({
      method: input.method ?? 'POST',
      url: url.toString(),
      session: session.defaultSession,
      redirect: 'error',
    })
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    request.once('error', fail)
    request.once('response', (response) => {
      response.resume()
      response.once('end', () => {
        if (settled) return
        settled = true
        const statusCode = response.statusCode
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Upload failed with HTTP ${statusCode}`))
        } else {
          resolve({ statusCode, bytes: info.size })
        }
      })
    })
    const sourceStream = createReadStream(source)
    let transferred = 0
    sourceStream.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      input.onProgress?.({ transferredBytes: transferred, totalBytes: info.size })
    })
    sourceStream.once('error', (error) => {
      request.abort()
      fail(error)
    })
    const onAbort = () => {
      sourceStream.destroy()
      request.abort()
      fail(input.signal?.reason ?? new Error('Upload aborted'))
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    request.once('close', () => input.signal?.removeEventListener('abort', onAbort))
    sourceStream.pipe(request as unknown as NodeJS.WritableStream)
  })
}

export function createElectronFileService(): FileService {
  return {
    async pickFiles(options: FilePickerOptions = {}) {
      const properties: Electron.OpenDialogOptions['properties'] = ['openFile']
      if (options.multiple) properties.push('multiSelections')
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        filters: fileFilters(options.filters),
        properties,
      }
      const owner = ownerWindow()
      const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled) return []
      return Promise.all(result.filePaths.map((file) => canonicalExistingPath(file)))
    },
    async pickDirectory(options: { title?: string } = {}) {
      const dialogOptions: Electron.OpenDialogOptions = { title: options.title, properties: ['openDirectory'] }
      const owner = ownerWindow()
      const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled || !result.filePaths[0]) return null
      return canonicalExistingPath(result.filePaths[0])
    },
    async saveFile(options: SaveFileOptions = {}) {
      const dialogOptions: Electron.SaveDialogOptions = {
        title: options.title,
        defaultPath: options.suggestedName,
        filters: fileFilters(options.filters),
      }
      const owner = ownerWindow()
      const result = owner ? await dialog.showSaveDialog(owner, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      if (result.canceled || !result.filePath) return null
      const destination = await canonicalDestinationPath(result.filePath)
      await mkdir(path.dirname(destination), { recursive: true })
      return destination
    },
    async openPath(targetPath: string, workspaceRoot?: string) {
      const safe = await canonicalExistingPath(targetPath, workspaceRoot)
      const error = await shell.openPath(safe)
      if (error) throw new Error(error)
    },
    async revealPath(targetPath: string, workspaceRoot?: string) {
      shell.showItemInFolder(await canonicalExistingPath(targetPath, workspaceRoot))
    },
    downloadFile,
    uploadFile,
  }
}
