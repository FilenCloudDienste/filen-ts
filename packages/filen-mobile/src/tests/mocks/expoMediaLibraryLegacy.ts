/**
 * Mock of expo-media-library/legacy for Vitest: permissions always granted, albums read from the
 * in-memory expo-media-library/next mock so both surfaces see the same library.
 *
 * Usage in test files:
 *
 *   vi.mock("expo-media-library/legacy", async () => await import("@/tests/mocks/expoMediaLibraryLegacy"))
 */

import { vi } from "vitest"
import { ml } from "@/tests/mocks/expoMediaLibrary"

const GRANTED = {
	granted: true,
	status: "granted",
	accessPrivileges: "all",
	expires: "never",
	canAskAgain: true
}

export const getPermissionsAsync = vi.fn(async () => GRANTED)

export const requestPermissionsAsync = vi.fn(async () => GRANTED)

export const getAlbumsAsync = vi.fn(async () => {
	return Array.from(ml.albums.values()).map(stored => ({
		id: stored.id,
		title: stored.title,
		type: "album",
		assetCount: stored.assetIds.length
	}))
})
