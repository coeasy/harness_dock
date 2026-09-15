// Compatibility browser module for plugins built before
// @deepseek-ai/dsh-client-runtime was renamed/split in the official Runtime.
// Keep this bundle dependency-free: it must be able to materialize before any
// optional third-party client bundle and must not add another graph edge.
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-client-runtime',
  factory: () => {
    const listeners = (store) => {
      for (const listener of [...store._listeners]) {
        try { listener() } catch (error) { console.error('[client-store] subscriber failed', error) }
      }
    }

    const clone = (value) => {
      if (typeof structuredClone === 'function') {
        try { return structuredClone(value) } catch (_) { /* fall through */ }
      }
      if (value === null || typeof value !== 'object') return value
      if (Array.isArray(value)) return value.map((item) => clone(item))
      if (typeof value !== 'object') return value
      const out = {}
      for (const [key, val] of Object.entries(value)) out[key] = clone(val)
      return out
    }

    const createSnapshotStore = (initial) => {
      const store = {
        _snapshot: initial,
        _listeners: new Set(),
        getSnapshot: () => store._snapshot,
        subscribe: (listener) => {
          store._listeners.add(listener)
          return () => store._listeners.delete(listener)
        },
        set: (next) => {
          store._snapshot = typeof next === 'function' ? next(store._snapshot) : next
          listeners(store)
        },
        update: (updater) => {
          // Deep clone (arrays included) so every subscriber receives a fresh
          // snapshot and legacy bundles cannot corrupt the store through
          // shared nested references.
          store._snapshot = typeof store._snapshot === 'object' && store._snapshot !== null
            ? clone(store._snapshot)
            : store._snapshot
          updater(store._snapshot)
          listeners(store)
        },
      }
      return store
    }

    // cordis-compatible plugin: a function that injects createSnapshotStore
    // into the plugin context so legacy third-party browser bundles that
    // import @deepseek-ai/dsh-client-runtime can resolve it as a service.
    const plugin = (ctx) => {
      if (ctx && typeof ctx.provide === 'function') {
        ctx.provide('clientStore', { createSnapshotStore })
      } else if (ctx && typeof ctx.set === 'function') {
        ctx.set('clientStore', { createSnapshotStore })
      }
    }
    plugin.createSnapshotStore = createSnapshotStore
    return plugin
  },
})
