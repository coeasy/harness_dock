import { describe, expect, it } from 'vitest'
import {
  gitTagToVersion,
  intersectVersions,
  pickLatestVersion,
  rejectFloatingDistTag,
  versionToGitTag,
} from '../src/versions.ts'

describe('gitTagToVersion', () => {
  it('strips the dsh-v prefix from official tags', () => {
    expect(gitTagToVersion('dsh-v0.1.1-rc.2')).toBe('0.1.1-rc.2')
  })

  it('returns null for unrelated tags', () => {
    expect(gitTagToVersion('v1.0.0')).toBeNull()
    expect(gitTagToVersion('latest')).toBeNull()
  })
})

describe('rejectFloatingDistTag', () => {
  it('rejects latest and next as pins', () => {
    expect(() => rejectFloatingDistTag('latest')).toThrow(/dist-tag/i)
    expect(() => rejectFloatingDistTag('next')).toThrow(/dist-tag/i)
  })

  it('allows an exact version string', () => {
    expect(rejectFloatingDistTag('0.1.1-rc.2')).toBe('0.1.1-rc.2')
  })
})

describe('intersectVersions', () => {
  it('keeps only versions present in both git tags and npm', () => {
    const git = ['0.1.1-rc.2', '0.1.1-rc.1', '0.1.2-rc.1']
    const npm = ['0.1.1-rc.2', '0.1.1-rc.1', '0.0.1-rc.1']
    expect(intersectVersions(git, npm)).toEqual(['0.1.1-rc.2', '0.1.1-rc.1'])
  })
})

describe('pickLatestVersion', () => {
  it('orders prerelease rc numbers after the numeric triple', () => {
    expect(
      pickLatestVersion(['0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.0-rc.7']),
    ).toBe('0.1.1-rc.2')
  })
})

describe('versionToGitTag', () => {
  it('round-trips an exact version', () => {
    expect(versionToGitTag('0.1.1-rc.2')).toBe('dsh-v0.1.1-rc.2')
  })
})
