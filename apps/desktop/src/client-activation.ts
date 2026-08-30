const HARNESSDOCK_PROTOCOL = /^harnessdock:\/\//i

/**
 * Extract protocol activations from Electron argv without interpreting them.
 * Parsing/authorization stays in the shared client core so every host uses the
 * same deep-link grammar.
 */
export function extractHarnessDockDeepLinks(argv: readonly string[]): string[] {
  return argv.filter((value) => HARNESSDOCK_PROTOCOL.test(value))
}
