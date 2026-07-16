import { vi } from "vitest"

// Global mock for the native @/modules/filen-exif module (aliased in vitest.config.ts).
// requireNativeModule() throws in the node test env, so every test that transitively imports
// the camera-upload / image-conversion pipeline resolves this instead. Defaults to a
// successful transplant; individual tests override via vi.mocked(transplantMetadata).mock*.
export const transplantMetadata = vi.fn(async (_sourceUri: string, _targetUri: string): Promise<boolean> => true)
