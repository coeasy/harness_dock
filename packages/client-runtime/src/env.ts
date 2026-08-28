export function scrubElectronEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  delete next.ELECTRON_NO_ASAR
  delete next.ELECTRON_NO_ATTACH_CONSOLE
  return next
}
