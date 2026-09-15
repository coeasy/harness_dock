#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { syncDsh } from './sync.ts'

const { values } = parseArgs({
  options: {
    pin: { type: 'string' },
    check: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
})

try {
  const result = await syncDsh({
    pin: values.pin,
    check: values.check,
    dryRun: values['dry-run'],
  })
  if (values.check) {
    if (result.changed) {
      console.error(
        `origin is stale; newer exact version available: ${result.origin.dshVersion} (${result.fields.join(', ')})`,
      )
      process.exitCode = 1
    } else {
      console.log(`origin is current at ${result.origin.dshVersion}`)
    }
  } else {
    console.log(
      JSON.stringify(
        {
          dshVersion: result.origin.dshVersion,
          gitTag: result.origin.gitTag,
          gitCommit: result.origin.gitCommit,
          docsHash: result.origin.docsHash,
          written: result.written,
          changed: result.changed,
        },
        null,
        2,
      ),
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
