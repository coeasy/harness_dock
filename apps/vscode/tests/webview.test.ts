import { describe, expect, it } from 'vitest'
import { renderErrorWebview, renderHarnessWebview } from '../src/webview.ts'

describe('renderHarnessWebview', () => {
  it('embeds the official SPA in an iframe with a frame-src CSP for loopback', () => {
    const html = renderHarnessWebview({
      url: 'http://127.0.0.1:43111',
      cspSource: 'vscode-webview://abc',
    })
    expect(html).toContain('frame-src http://127.0.0.1:43111')
    expect(html).toContain('src="http://127.0.0.1:43111"')
    expect(html).toContain('<iframe')
  })
})

describe('renderErrorWebview', () => {
  const input = {
    message: 'dsh web failed to become ready: timeout',
    retry: true,
    logHint: 'see the output panel',
    cspSource: 'vscode-webview://abc',
  }

  it('shows the error message with a CSP that matches the harness style', () => {
    const html = renderErrorWebview(input)
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("default-src 'none'")
    expect(html).toContain(`style-src ${input.cspSource} 'unsafe-inline'`)
    expect(html).toContain('HarnessDock failed to start')
    expect(html).toContain('dsh web failed to become ready: timeout')
  })

  it('renders a Retry button and the log hint when requested', () => {
    const html = renderErrorWebview(input)
    expect(html).toContain('id="retry"')
    expect(html).toContain('Retry')
    expect(html).toContain('see the output panel')
    expect(html).toContain("postMessage({ type: 'retry' })")
  })

  it('omits the Retry button when retry is false', () => {
    const html = renderErrorWebview({ ...input, retry: false })
    expect(html).not.toContain('id="retry"')
    expect(html).not.toContain('postMessage')
  })

  it('escapes HTML metacharacters in the error message', () => {
    const html = renderErrorWebview({ ...input, message: '<script>alert(1)</script> & "quoted"' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('does not affect the harness webview', () => {
    const harness = renderHarnessWebview({
      url: 'http://127.0.0.1:43111',
      cspSource: 'vscode-webview://abc',
    })
    expect(harness).not.toContain('HarnessDock failed to start')
    expect(harness).not.toContain('script-src')
    expect(harness).toContain('<iframe')
  })
})
