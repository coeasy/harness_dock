import { describe, expect, it } from 'vitest'
import { fmt, localeOf, t } from '../src/i18n.ts'

describe('localeOf', () => {
  it('maps zh* to zh-CN', () => {
    expect(localeOf('zh-CN')).toBe('zh-CN')
    expect(localeOf('zh-TW')).toBe('zh-CN')
    expect(localeOf('zh')).toBe('zh-CN')
  })

  it('maps everything else to en', () => {
    expect(localeOf('en-US')).toBe('en')
    expect(localeOf('en-GB')).toBe('en')
    expect(localeOf('de-DE')).toBe('en')
    expect(localeOf(undefined)).toBe('en')
  })
})

describe('t()', () => {
  it('returns the zh-CN entry for zh locales', () => {
    expect(t('tray.quit', 'zh-CN')).toBe('退出 HarnessDock')
    expect(t('crash.renderer.title', 'zh-TW')).toBe('工作区渲染进程崩溃')
  })

  it('returns the en entry for non-zh locales', () => {
    expect(t('tray.quit', 'en-US')).toBe('Quit HarnessDock')
    expect(t('crash.renderer.title', 'de-DE')).toBe('The workspace renderer crashed')
  })

  it('falls back to the key itself for a missing key', () => {
    expect(t('no.such.key', 'zh-CN')).toBe('no.such.key')
    expect(t('no.such.key', 'en')).toBe('no.such.key')
  })

  it('resolves the system locale without crashing in a plain Node env', () => {
    // In a vitest (non-Electron) process `app.getLocale()` is unavailable and
    // systemLocale() must fall back to 'en' instead of throwing.
    const value = t('tray.toggle')
    expect(typeof value).toBe('string')
    expect(value.length).toBeGreaterThan(0)
  })

  it('covers every user-visible surface referenced by the app', () => {
    const keys = [
      'common.appTitle',
      'boot.failed.title',
      'boot.failed.summary',
      'boot.failed.retry',
      'boot.failed.message',
      'download.failed.title',
      'download.failed.detail',
      'crash.renderer.title',
      'crash.renderer.detail',
      'crash.renderer.reload',
      'crash.renderer.ignore',
      'crash.unresponsive.title',
      'crash.unresponsive.detail',
      'crash.unresponsive.wait',
      'crash.unresponsive.reload',
      'crash.guard.title',
      'crash.guard.message',
      'update.available.title',
      'update.available.body',
      'update.downloaded.title',
      'update.downloaded.body',
      'update.restart.title',
      'update.restart.detail',
      'update.restart.now',
      'update.restart.later',
      'update.noFeed.body',
      'rollback.notification',
      'tray.toggle',
      'tray.checkUpdate',
      'tray.openLog',
      'tray.diagnostics',
      'tray.versions',
      'tray.quit',
      'tray.tooltip',
      'splash.starting',
      'splash.loading',
      'splash.startingRuntime',
      'splash.firstLaunch',
      'splash.downloading',
      'splash.resolving',
      'splash.ready',
      'splash.loadingInterface',
      'splash.hint.network',
      'splash.hint.stuck',
      'splash.hint.resume',
      'splash.error.title',
      'splash.error.retry',
      'splash.error.openLog',
      'splash.error.copyError',
      'splash.error.copied',
    ]
    for (const key of keys) {
      expect(t(key, 'zh-CN')).not.toBe(key)
      expect(t(key, 'en')).not.toBe(key)
    }
  })
})

describe('fmt()', () => {
  it('replaces {name} placeholders', () => {
    expect(fmt('New version {version} downloaded', { version: '0.2.0' })).toBe(
      'New version 0.2.0 downloaded',
    )
    expect(fmt('{a} + {b}', { a: 'x', b: 3 })).toBe('x + 3')
  })

  it('keeps unknown placeholders untouched', () => {
    expect(fmt('hi {missing}', {})).toBe('hi {missing}')
  })
})
