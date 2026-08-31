import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const resourcePath = path.resolve(
  import.meta.dirname,
  '../../../apps/tauri/src-tauri/resources/dsh-client-runtime-compat/client.js',
)

describe('legacy client-runtime compatibility bundle', () => {
  it('registers createSnapshotStore and preserves the old store contract', async () => {
    const registrations: Array<{ factory: () => Record<string, unknown> }> = []
    const source = await readFile(resourcePath, 'utf8')
    vm.runInNewContext(source, {
      console,
      window: { __ModuleLoader__: { load: (registration: typeof registrations[number]) => registrations.push(registration) } },
    })

    expect(registrations).toHaveLength(1)
    const exports = registrations[0]?.factory() as {
      createSnapshotStore: <T>(initial: T) => {
        getSnapshot: () => T
        subscribe: (listener: () => void) => () => void
        set: (next: T) => void
      }
    }
    const store = exports.createSnapshotStore({ value: 1 })
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })

    store.set({ value: 2 })
    expect(store.getSnapshot()).toEqual({ value: 2 })
    expect(notifications).toBe(1)
    unsubscribe()
    store.set({ value: 3 })
    expect(notifications).toBe(1)
  })
})
