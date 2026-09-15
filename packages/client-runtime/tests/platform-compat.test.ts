import { describe, expect, it } from 'vitest'
import { isPackagePlatformCompatible } from '../src/fetch-runtime.ts'

describe('runtime package platform compatibility', () => {
  it('rejects Linux-only packages on Windows', () => {
    expect(isPackagePlatformCompatible({ os: ['linux'] }, 'win32', 'x64')).toBe(false)
  })

  it('rejects macOS-only packages on Windows', () => {
    expect(isPackagePlatformCompatible({ os: ['darwin'] }, 'win32', 'x64')).toBe(false)
  })

  it('accepts Windows x64 packages on Windows x64', () => {
    expect(isPackagePlatformCompatible({ os: ['win32'], cpu: ['x64'] }, 'win32', 'x64')).toBe(true)
  })

  it('honors npm negative os and cpu constraints', () => {
    expect(isPackagePlatformCompatible({ os: ['!win32'] }, 'win32', 'x64')).toBe(false)
    expect(isPackagePlatformCompatible({ cpu: ['!x64'] }, 'win32', 'x64')).toBe(false)
  })

  it('allows unconstrained and any packages', () => {
    expect(isPackagePlatformCompatible({}, 'linux', 'arm64')).toBe(true)
    expect(isPackagePlatformCompatible({ os: ['any'], cpu: ['any'] }, 'darwin', 'arm64')).toBe(true)
  })

  it('keeps negative-only constraints compatible with other targets', () => {
    expect(isPackagePlatformCompatible({ os: ['!linux'], cpu: ['!arm64'] }, 'win32', 'x64')).toBe(true)
  })
})
