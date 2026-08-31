export type BootFailureDisposition = 'degraded-runtime' | 'fatal-host'

/**
 * The dsh Runtime is a managed child service, not the HarnessDock host itself.
 * Once a Runtime start was attempted, a failure before connection is recoverable
 * at the host level: keep Diagnostics/tray/retry alive. Failures outside that
 * boundary remain host-fatal and are handled by the top-level crash guard.
 */
export function classifyBootFailure(input: {
  runtimeStartAttempted: boolean
  runtimeConnected: boolean
}): BootFailureDisposition {
  return input.runtimeStartAttempted && !input.runtimeConnected
    ? 'degraded-runtime'
    : 'fatal-host'
}
