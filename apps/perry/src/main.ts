import 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { App, Text, VStack, WebView } from 'perry/ui'
import {
  LocalRuntimeProvider,
  PERRY_HOST,
  RuntimeLeaseConflictError,
  acquireRuntimeLease,
} from '../../../packages/bootstrap/src/index.ts'
import {
  bundledRoot,
  iconPath,
  originPath,
  perryUserDataDir,
  pluginPath,
  resourceRoot,
} from './paths.ts'

/*
 * Perry v0.5.1220 compatibility shim.
 *
 * Its published prebuilt `full` stdlib accidentally enables the external HTTP
 * client pump even when the program does not import node:http/https. Those FFI
 * symbols live in perry-ext-http, which the compiler only links when a program
 * declares the HTTP module surface. Perry upstream fixed this after 0.5.1220
 * (PerryTS/perry#5983 / #7491), but 0.5.1220 is still the latest formal release.
 *
 * The side-effect import above deliberately selects perry-ext-http so the
 * published compiler can resolve its own stdlib references. Remove it once a
 * formal Perry release containing #5983 is pinned here.
 */

function openExternalUrl(url: string): void {
  try {
    const command =
      process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (error) {
    console.error(`[perry] failed to open external URL ${url}:`, error)
  }
}

function showFatal(message: string): void {
  const body = VStack(12, [
    Text('HarnessDock Native Preview'),
    Text(message),
    Text('Electron Stable remains the compatibility fallback for this preview release.'),
  ])
  App({
    title: `${PERRY_HOST.productName} - Startup Error`,
    width: 760,
    height: 360,
    body,
  })
}

async function run(): Promise<void> {
  let lease: Awaited<ReturnType<typeof acquireRuntimeLease>>
  try {
    lease = await acquireRuntimeLease({ host: 'perry' })
  } catch (error) {
    if (error instanceof RuntimeLeaseConflictError) {
      showFatal(
        `Another HarnessDock desktop host is already managing the shared dsh runtime. ` +
          `Close that host before starting Perry Preview. ${error.message}`,
      )
      return
    }
    throw error
  }

  let provider: LocalRuntimeProvider | undefined
  try {
    const resources = resourceRoot()
    if (!existsSync(originPath(resources))) {
      throw new Error(`origin.json is missing from ${resources}`)
    }
    if (!existsSync(pluginPath(resources))) {
      throw new Error(`embedded client plugin is missing from ${resources}`)
    }

    provider = new LocalRuntimeProvider({
      originPath: originPath(resources),
      pluginPath: pluginPath(resources),
      packaged: true,
      bundledRoot: bundledRoot(resources),
      userDataDir: perryUserDataDir(),
      stopTimeoutMs: 12_000,
      log: (message) => console.log(`[perry] ${message}`),
      onProgress: (event) => {
        if (event.stage === 'fetch') {
          console.log(`[perry] runtime download ${event.percent ?? 0}% ${event.name ?? ''}`)
        }
      },
      onRollback: (info) => {
        console.warn(`[perry] rolled back dsh ${info.from} -> ${info.to}`)
      },
    })
    const session = await provider.connect()
    const result = provider.bootstrapResult
    if (!result) throw new Error('LocalRuntimeProvider connected without a bootstrap result.')

    await lease.updateRuntime({
      runtimePid: result.ready.pid,
      dshVersion: result.ready.dshVersion,
    })

    const appOrigin = new URL(session.appUrl).origin
    const webview = WebView({
      url: session.appUrl,
      ephemeral: false,
      width: 1280,
      height: 820,
      onShouldNavigate: (target) => {
        try {
          const parsed = new URL(target)
          if (parsed.origin === appOrigin) return true
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            openExternalUrl(target)
          } else {
            console.warn(`[perry] blocked non-http navigation: ${target}`)
          }
        } catch {
          console.warn(`[perry] blocked malformed navigation: ${target}`)
        }
        return false
      },
      onLoaded: (url) => console.log(`[perry] webview loaded ${url}`),
      onError: (code, message) => console.error(`[perry] webview error ${code}: ${message}`),
    })

    // Perry's UI lowering requires App() to receive a direct object literal;
    // dynamic object spreads or a separately constructed config are rejected.
    // The preview packer always ships icon-256.png as a fixed resource.
    App({
      title: 'HarnessDock Native Preview',
      width: 1280,
      height: 840,
      icon: iconPath(resources),
      body: VStack([webview]),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[perry] startup failed:', error)
    showFatal(message)
  } finally {
    if (provider) {
      try {
        await provider.disconnect()
      } catch (error) {
        console.error('[perry] runtime stop failed:', error)
      }
    }
    await lease.release().catch((error) => console.error('[perry] runtime lease release failed:', error))
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[perry] fatal:', error)
  showFatal(message)
})
