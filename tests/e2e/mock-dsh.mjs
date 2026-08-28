// Mock dsh for the HarnessDock E2E smoke tests.
//
// Emulates the DeepSeek Harness "web" server that the desktop shell boots:
//   1. listens on 127.0.0.1:<random port>
//   2. prints `dsh web: http://127.0.0.1:<port>` on stdout (the runtime's
//      parseWebUrl fast-path)
//   3. writes the ready.json file that DSH_EMBEDDED_READY_FILE points to
//      ({url, host, port, pid, dshVersion}) so DshRuntime.waitForReady() settles
//   4. keeps serving HTML until the process is killed (shutdown ladder / SIGTERM)
//
// It is launched through a generated `mock-dsh.cmd` wrapper (DSH_BIN) so the
// client-runtime's Windows .cmd routing spawns it exactly like a real dsh bin.
//
// Test-only extras:
//   - DSH_MOCK_PID_FILE: writes this node process's own pid there so tests can
//     assert the mock is truly gone after the app quits.
//   - GET /__mock/status returns {"ok":true} so tests can probe liveness
//     without depending on the HTML payload.
import http from 'node:http'
import { writeFile } from 'node:fs/promises'

const READY_FILE = process.env.DSH_EMBEDDED_READY_FILE
const PID_FILE = process.env.DSH_MOCK_PID_FILE
const VERSION = process.env.DSH_EMBEDDED_VERSION ?? '0.0.0-mock'

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>HarnessDock</title>
</head>
<body>
  <h1 id="mock-title">Mock DSH</h1>
  <p id="mock-status">mock dsh ready</p>
</body>
</html>
`

let htmlRequests = 0

const server = http.createServer((req, res) => {
  // Lenient on leading slashes (tests may build <url>/__mock/status with a
  // trailing slash in the base URL) and on query strings.
  const path = (req.url ?? '/').split('?')[0].replace(/\/{2,}/g, '/')
  if (path === '/__mock/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pid: process.pid, htmlRequests }))
    return
  }
  htmlRequests += 1
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('mock dsh: no loopback address')
  }
  const port = address.port
  const url = `http://127.0.0.1:${port}`
  try {
    process.stdout.write(`dsh web: ${url}\n`)
  } catch {
    // stdout pipe already gone (parent died): fall through to the ready file
  }
  const ready = { url, host: '127.0.0.1', port, pid: process.pid, dshVersion: VERSION }
  if (READY_FILE) {
    void writeFile(READY_FILE, `${JSON.stringify(ready, null, 2)}\n`, 'utf8').catch(() => undefined)
  }
  if (PID_FILE) {
    void writeFile(PID_FILE, `${process.pid}\n`, 'utf8').catch(() => undefined)
  }
})

// Keep the event loop alive independently of the server handle.
const keepAlive = setInterval(() => {}, 1 << 30)

function shutdown() {
  clearInterval(keepAlive)
  try {
    server.close(() => process.exit(0))
  } catch {
    process.exit(0)
  }
  // Failsafe in case server.close() never fires its callback.
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('uncaughtException', (error) => {
  process.stderr.write(`mock dsh uncaughtException: ${String(error)}\n`)
  process.exit(1)
})
