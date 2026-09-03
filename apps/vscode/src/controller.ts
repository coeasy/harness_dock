/**
 * Pure open/stop session state machine for the VS Code / Cursor host.
 *
 * No `vscode` imports here on purpose: every decision the extension makes about
 * whether to start, reuse, or stop the shared runtime is computed in this
 * module so it can be unit-tested without a VS Code runtime.
 *
 * Model:
 *   - the extension hosts a single shared runtime; every webview panel embeds
 *     the same `ready.url`
 *   - with keep-alive OFF, closing the LAST panel stops the runtime
 *   - with keep-alive ON, panels may all close while the runtime keeps running
 *     until an explicit stop (`dshClient.stop`) or extension deactivation
 */

export interface ReadyState {
  url: string
  port: number
  dshVersion: string
}

export interface SessionSnapshot {
  running: boolean
  ready: ReadyState | undefined
  panelCount: number
  keepAlive: boolean
}

export class HarnessSession {
  private ready: ReadyState | undefined
  private panelCount = 0
  private keepAlive: boolean

  constructor(keepAlive = false) {
    this.keepAlive = keepAlive
  }

  setKeepAlive(value: boolean): void {
    this.keepAlive = value
  }

  get isRunning(): boolean {
    return this.ready !== undefined
  }

  get readyInfo(): ReadyState | undefined {
    return this.ready
  }

  /** Record a successful runtime start; subsequent panels reuse `ready.url`. */
  recordStarted(ready: ReadyState): void {
    this.ready = ready
  }

  /** Call when a new webview panel is created. */
  panelOpened(): void {
    this.panelCount += 1
  }

  /**
   * Call when a webview panel is disposed. Returns true when the runtime should
   * be stopped now: keep-alive is off, no panels remain open, and a runtime is
   * running. Clears the cached ready info in that case so a later open restarts.
   */
  panelClosed(): boolean {
    this.panelCount = Math.max(0, this.panelCount - 1)
    if (!this.keepAlive && this.panelCount === 0 && this.isRunning) {
      this.ready = undefined
      return true
    }
    return false
  }

  /**
   * Explicit stop (`dshClient.stop`, deactivate, keep-alive-off shutdown).
   * Returns true when a running runtime needs stopping; clears cached state so
   * a later open starts fresh.
   */
  stopRequested(): boolean {
    const running = this.isRunning
    this.ready = undefined
    return running
  }

  snapshot(): SessionSnapshot {
    return {
      running: this.isRunning,
      ready: this.ready,
      panelCount: this.panelCount,
      keepAlive: this.keepAlive,
    }
  }
}
