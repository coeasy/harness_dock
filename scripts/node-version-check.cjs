/**
 * Minimal Node version gate used by build.bat / build.sh on bare machines.
 * Expected floor comes from scripts/versions.json (single source of truth).
 * Exit 0  -> current node satisfies engines (^<maj>.<min>.0 || >=<maj+2>.0.0)
 * Exit 1  -> too old or unusable, caller must bootstrap a portable Node
 */
'use strict'
const { node: expected } = require('./versions.json')
const [expectedMajor, expectedMinor] = expected.split('.').map(Number)
const [maj, min] = process.versions.node.split('.').map(Number)
const ok = (maj === expectedMajor && min >= expectedMinor) || maj >= expectedMajor + 2
if (!ok) {
  console.error(
    `[bootstrap] Node ${process.versions.node} does not satisfy ^${expectedMajor}.${expectedMinor}.0 || >=${expectedMajor + 2}.0.0`,
  )
}
process.exit(ok ? 0 : 1)
