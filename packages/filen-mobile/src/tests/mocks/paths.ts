/**
 * The real @/lib/paths for Vitest. It is pure (node "path" plus the aliased expo-file-system mock),
 * so there is nothing to fake; suites that mock the module to override one helper spread this in.
 *
 *   vi.mock("@/lib/paths", async () => await import("@/tests/mocks/paths"))
 *
 *   vi.mock("@/lib/paths", async () => ({
 *       ...(await import("@/tests/mocks/paths")),
 *       normalizeFilePathForExpo: (p: string) => p
 *   }))
 */

import { vi } from "vitest"

export const { normalizeFilePathForSdk, normalizeFilePathForExpo, normalizeFilePathForBlobUtil, stripUriFragmentAndQuery } =
	await vi.importActual<typeof import("@/lib/paths")>("@/lib/paths")
