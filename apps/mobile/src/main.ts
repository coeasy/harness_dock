import {
  App,
  Button,
  NavStack,
  SecureField,
  Text,
  TextField,
  VStack,
  WebView,
  state,
  webviewClearCookies,
  webviewLoadUrl,
  webviewReload,
} from 'perry/ui'
import { RemoteRuntimeProvider } from '../../../packages/bootstrap/src/runtime-provider.ts'

let gatewayUrl = ''
let pairingCode = ''
let deviceName = 'HarnessDock Mobile'
let allowedOrigin = ''
let provider: RemoteRuntimeProvider | undefined

const route = state('connect')
const status = state('Enter the HTTPS gateway URL and the one-time pairing code shown by HarnessDock Desktop.')

const harnessWebView = WebView({
  url: 'about:blank',
  ephemeral: false,
  width: 390,
  height: 760,
  onShouldNavigate: (target) => {
    if (target === 'about:blank') return true
    try {
      const parsed = new URL(target)
      if (allowedOrigin && parsed.origin === allowedOrigin) return true
      status.set(`Blocked external navigation: ${parsed.hostname}. Mobile OAuth/external-browser handoff is not enabled yet.`)
    } catch {
      status.set('Blocked malformed navigation request.')
    }
    return false
  },
  onLoaded: (url) => {
    status.set(`Connected: ${url}`)
  },
  onError: (code, message) => {
    status.set(`Harness WebView error ${code}: ${message}`)
  },
})

async function connectRemoteRuntime(): Promise<void> {
  status.set('Checking gateway…')
  try {
    const next = new RemoteRuntimeProvider({
      gatewayUrl,
      pairingCode,
      deviceName,
    })
    const health = await next.health()
    if (!health.ok) throw new Error(health.message || 'Gateway health check failed.')

    status.set('Pairing device…')
    const session = await next.connect()
    provider = next
    allowedOrigin = new URL(session.appUrl).origin
    webviewLoadUrl(harnessWebView, session.appUrl)
    route.set('harness')
  } catch (error) {
    status.set(error instanceof Error ? error.message : String(error))
  }
}

async function disconnectRemoteRuntime(): Promise<void> {
  await provider?.disconnect()
  provider = undefined
  allowedOrigin = ''
  webviewClearCookies(harnessWebView)
  webviewLoadUrl(harnessWebView, 'about:blank')
  route.set('connect')
  status.set('Disconnected. Enter a new pairing code to reconnect.')
}

const connectPage = VStack(12, [
  Text('HarnessDock Mobile Preview'),
  Text('Remote Runtime mode — this app never downloads or launches the desktop dsh runtime.'),
  TextField('https://your-harnessdock-gateway.example', (value) => {
    gatewayUrl = value.trim()
  }),
  SecureField('Pairing code (for example 1234-5678)', (value) => {
    pairingCode = value.trim()
  }),
  TextField('Device name', (value) => {
    deviceName = value.trim() || 'HarnessDock Mobile'
  }),
  Button('Connect', () => {
    void connectRemoteRuntime()
  }),
  status.text(),
])

const harnessPage = VStack(8, [
  harnessWebView,
  Button('Reload Harness', () => webviewReload(harnessWebView)),
  Button('Disconnect', () => {
    void disconnectRemoteRuntime()
  }),
  status.text(),
])

// Perry's NavStack lowering requires direct route object literals and App()
// requires a direct config object literal. Keep this shape compiler-friendly.
App({
  title: 'HarnessDock Mobile Preview',
  width: 390,
  height: 844,
  body: NavStack(route, [
    { name: 'connect', body: connectPage },
    { name: 'harness', body: harnessPage },
  ]),
})
