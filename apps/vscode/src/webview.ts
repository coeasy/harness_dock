export interface ErrorWebviewInput {
  message: string
  retry: boolean
  logHint?: string
  cspSource: string
}

export function renderHarnessWebview(input: { url: string; cspSource: string }): string {
  const origin = new URL(input.url).origin
  const csp = [
    `default-src 'none'`,
    `frame-src ${origin}`,
    `style-src ${input.cspSource} 'unsafe-inline'`,
    `img-src ${input.cspSource} data:`,
  ].join('; ')
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body, iframe { margin: 0; padding: 0; height: 100%; width: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe src="${input.url}" allow="clipboard-read; clipboard-write"></iframe>
  </body>
</html>
`
}

/**
 * Actionable "start failed" page: shows the error summary, a log hint and an
 * optional Retry button (posts `{ type: 'retry' }` back to the extension, which
 * re-runs `dshClient.open`). CSP mirrors renderHarnessWebview plus a scoped
 * `script-src 'unsafe-inline'` so the Retry button can talk to the host.
 */
export function renderErrorWebview(input: ErrorWebviewInput): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${input.cspSource} 'unsafe-inline'`,
    `img-src ${input.cspSource} data:`,
    `script-src 'unsafe-inline'`,
  ].join('; ')
  const summary = escapeHtml(input.message)
  const logHint = input.logHint ? `<p class="hint">${escapeHtml(input.logHint)}</p>` : ''
  const retry = input.retry
    ? `<button id="retry" type="button" class="btn">Retry</button>`
    : ''
  const retryScript = input.retry
    ? `
    <script>
      ;(function () {
        const vscode = acquireVsCodeApi()
        document.getElementById('retry').addEventListener('click', function () {
          vscode.postMessage({ type: 'retry' })
        })
      })()
    </script>`
    : ''
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; height: 100%; }
      body {
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        display: flex; align-items: center; justify-content: center;
        padding: 32px;
      }
      main { max-width: 640px; width: 100%; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      .message {
        white-space: pre-wrap; word-break: break-word;
        background: var(--vscode-inputValidation-errorBackground, #f3d9d9);
        border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
        border-radius: 4px; padding: 12px; margin: 0 0 12px;
      }
      .hint { opacity: 0.8; margin: 0 0 16px; }
      .btn {
        font: inherit; color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer;
      }
      .btn:hover { background: var(--vscode-button-hoverBackground); }
    </style>
  </head>
  <body>
    <main>
      <h1>HarnessDock failed to start</h1>
      <p class="message">${summary}</p>
      ${logHint}
      ${retry}
    </main>
    ${retryScript}
  </body>
</html>
`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
