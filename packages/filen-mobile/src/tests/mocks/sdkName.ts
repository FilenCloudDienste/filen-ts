/**
 * parseName/encodeName stubs shaped like the filen-rs name.rs contract, for Vitest: parseName throws
 * on names the validator rejects and passes accepted names through byte-identical (NFC is a no-op for
 * ASCII fixtures); encodeName deterministically maps rejected names into a valid form (":" → "：",
 * other forbidden → "＿") and throws only on empty/over-length.
 *
 * Usage in test files (spread next to the rest of the @filen/sdk-rs mock):
 *
 *   vi.mock("@filen/sdk-rs", async () => {
 *   	const { parseName, encodeName } = await import("@/tests/mocks/sdkName")
 *
 *   	return { ..., parseName, encodeName }
 *   })
 */

import { vi } from "vitest"

const FORBIDDEN = /[\u0000-\u001f\u007f/\\:*?"<>|]/

export const parseName = vi.fn((name: string) => {
	if (name.length === 0 || name.length > 255 || FORBIDDEN.test(name) || name.startsWith(" ") || /[. ]$/.test(name)) {
		throw new Error(`invalid name: ${name}`)
	}

	return name
})

export const encodeName = vi.fn((name: string) => {
	if (name.length === 0 || name.length > 255) {
		throw new Error(`unencodable name: ${name}`)
	}

	return name
		.replace(/[\u0000-\u001f\u007f/\\*?"<>|]/g, "＿")
		.replace(/:/g, "：")
		.replace(/^ +/, "␠")
		.replace(/[. ]+$/, "．")
})

export const mockParseName = parseName

