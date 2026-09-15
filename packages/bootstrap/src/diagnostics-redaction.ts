const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)/i

export const REDACTED = '[REDACTED]'

export function redactDiagnostics<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map((item) => redactValue(item, seen))
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(nested, seen)
    }
    return output
  }

  return value
}
