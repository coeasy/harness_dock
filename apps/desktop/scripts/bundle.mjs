// Desktop bundle: main (ESM) + sandboxed helper preloads (CJS).
//
// The main bundle needs a `require` injection banner: Electron's ESM main
// process has no `require` in scope, and esbuild's ESM output shim for dynamic
// requires (the electron-updater -> fs-extra -> graceful-fs CJS chain) falls
// back to a Proxy that throws "Dynamic require of ... is not supported". A real
// `require` via createRequire makes those CommonJS deps boot unchanged.
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const MAIN_BANNER = [
  "import { createRequire } from 'node:module';",
  "if (typeof globalThis.require !== 'function') { globalThis.require = createRequire(import.meta.url); }",
].join(' ')

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  outfile: 'dist/main.js',
  banner: { js: MAIN_BANNER },
})

// Preloads are CommonJS and must NOT bundle electron: the sandboxed preload
// environment only provides a limited `require('electron')` (contextBridge /
// ipcRenderer). Bundling the electron npm package in would make it try to
// require('fs') etc. and fail silently. The `.cjs` extension also forces CJS
// loading even though the package is `"type": "module"`.
const preloads = [
  ['src/preload.ts', 'dist/preload.cjs'],
  ['src/splash-preload.ts', 'dist/splash-preload.cjs'],
  ['src/diagnostics/diagnostics-preload.ts', 'dist/diagnostics-preload.cjs'],
  ['src/mobile/mobile-preload.ts', 'dist/mobile-preload.cjs'],
]

for (const [entry, outfile] of preloads) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(root, outfile),
  })
}
