import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
	default: {
		isAuthed: vi.fn()
	}
}))

import { isIncomingSharePath, redirectSystemPath } from "@/routes/+native-intent"
import auth from "@/lib/auth"
import useIncomingShareStore from "@/features/incomingShare/store/useIncomingShare.store"

describe("isIncomingSharePath", () => {
	// Regression: RN's built-in URL.hostname is "" for custom schemes, so the share deep link
	// (iofilenapp://expo-sharing, opened by the expo-sharing share extension) must be matched off the raw
	// path rather than via `new URL(path).hostname`.
	it("matches the iofilenapp://expo-sharing deep link the share extension opens", () => {
		expect(isIncomingSharePath("iofilenapp://expo-sharing")).toBe(true)
	})

	it("matches with a trailing slash, query or fragment", () => {
		expect(isIncomingSharePath("iofilenapp://expo-sharing/")).toBe(true)
		expect(isIncomingSharePath("iofilenapp://expo-sharing?dataUrl=file%3A%2F%2Fx")).toBe(true)
		expect(isIncomingSharePath("iofilenapp://expo-sharing#x")).toBe(true)
	})

	it("matches a scheme-stripped or slash-prefixed authority form", () => {
		expect(isIncomingSharePath("expo-sharing")).toBe(true)
		expect(isIncomingSharePath("/expo-sharing")).toBe(true)
	})

	it("does not match other deep links, https links, or expo-sharing as a mere path segment", () => {
		expect(isIncomingSharePath("iofilenapp://note/abc")).toBe(false)
		expect(isIncomingSharePath("iofilenapp://drive/expo-sharing")).toBe(false)
		expect(isIncomingSharePath("iofilenapp://expo-sharing-other")).toBe(false)
		expect(isIncomingSharePath("https://filen.io/expo-sharing")).toBe(false)
	})
})

describe("redirectSystemPath", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		useIncomingShareStore.getState().setProcess(false)
	})

	it("flags an incoming share for processing when authenticated", async () => {
		vi.mocked(auth.isAuthed).mockResolvedValue({ isAuthed: true } as Awaited<ReturnType<typeof auth.isAuthed>>)

		const result = await redirectSystemPath({ path: "iofilenapp://expo-sharing", initial: false })

		expect(result).toBeNull()
		expect(useIncomingShareStore.getState().process).toBe(true)
	})

	it("does not flag a share when unauthenticated", async () => {
		vi.mocked(auth.isAuthed).mockResolvedValue({ isAuthed: false })

		await redirectSystemPath({ path: "iofilenapp://expo-sharing", initial: true })

		expect(useIncomingShareStore.getState().process).toBe(false)
	})

	it("ignores non-share deep links without consulting auth", async () => {
		await redirectSystemPath({ path: "iofilenapp://note/abc", initial: false })

		expect(auth.isAuthed).not.toHaveBeenCalled()
		expect(useIncomingShareStore.getState().process).toBe(false)
	})
})

describe("redirectSystemPath deep-link nullification invariant", () => {
	// The single return-null is the ONLY thing stopping external iofilenapp://<route> URLs from
	// cold-starting uuid-parameterized screens whose data resolution assumes in-session seeding.
	// Every expo-router route is URL-addressable by default, so any future pass-through here must
	// first revisit how those screens resolve their data.
	beforeEach(() => {
		vi.clearAllMocks()
		useIncomingShareStore.getState().setProcess(false)
	})

	const paths = [
		"iofilenapp://note/some-uuid",
		"iofilenapp://sharedIn/some-uuid",
		"iofilenapp://tabs/drive/some-uuid",
		"https://example.com/x",
		"::: not a url @@@"
	]

	for (const path of paths) {
		it(`resolves to null for ${path} regardless of the initial flag`, async () => {
			expect(await redirectSystemPath({ path, initial: false })).toBeNull()
			expect(await redirectSystemPath({ path, initial: true })).toBeNull()
		})
	}
})
