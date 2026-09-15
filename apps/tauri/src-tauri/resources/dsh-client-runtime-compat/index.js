// Host face for the legacy client-runtime compatibility package.
// The package is intentionally a no-op on Node; its browser face below only
// restores the small snapshot-store API used by older third-party plugins.
export const name = 'harnessdock-client-runtime-compat'

export function apply() {}
