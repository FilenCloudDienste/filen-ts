import { vi } from "vitest"

// Global mock for the native @/modules/filen-net module (aliased in vitest.config.ts): its index
// imports expo-modules-core, which cannot load in Node. Defaults to an initialized verifier.
export const initTls = vi.fn((): boolean => true)
export const tlsReady = vi.fn((): boolean => true)
