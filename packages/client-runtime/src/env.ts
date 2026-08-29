const PRESERVE_ELECTRON_NODE = 'DSH_PRESERVE_ELECTRON_RUN_AS_NODE'

export function scrubElectronEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  const preserveElectronNode = next[PRESERVE_ELECTRON_NODE] === '1'
  delete next[PRESERVE_ELECTRON_NODE]
  if (!preserveElectronNode) delete next.ELECTRON_RUN_AS_NODE
  delete next.ELECTRON_NO_ASAR
  delete next.ELECTRON_NO_ATTACH_CONSOLE
  return next
}
