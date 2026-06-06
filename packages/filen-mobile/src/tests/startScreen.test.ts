import { vi, describe, it, expect } from "vitest"

// buildStartScreenHref is a pure switch — zero dependencies that need mocking.
// secureStore is only used by the hook (useStartScreen), not the function under test.
// We still need to mock the hook import so the module doesn't explode when loaded.
vi.mock("@/lib/secureStore", () => ({
	useSecureStore: vi.fn()
}))

import { buildStartScreenHref } from "@/features/settings/startScreen"

const ANY_UUID = "ffffffff-0000-0000-0000-000000000001"

describe("buildStartScreenHref", () => {
	it("returns '/tabs/photos' for 'photos'", () => {
		expect(buildStartScreenHref("photos", ANY_UUID)).toBe("/tabs/photos")
	})

	it("returns '/tabs/notes' for 'notes'", () => {
		expect(buildStartScreenHref("notes", ANY_UUID)).toBe("/tabs/notes")
	})

	it("returns '/tabs/chats' for 'chats'", () => {
		expect(buildStartScreenHref("chats", ANY_UUID)).toBe("/tabs/chats")
	})

	it("returns '/tabs/more' for 'more'", () => {
		expect(buildStartScreenHref("more", ANY_UUID)).toBe("/tabs/more")
	})

	it("returns an object with pathname and params for 'drive'", () => {
		const result = buildStartScreenHref("drive", "abc-123")

		expect(result).toEqual({
			pathname: "/tabs/drive/[uuid]",
			params: { uuid: "abc-123" }
		})
	})

	it("drive case: uuid param equals exactly the rootUuid argument (no mutation)", () => {
		const uuid = "deadbeef-cafe-babe-0000-000000000001"
		const result = buildStartScreenHref("drive", uuid) as { pathname: string; params: { uuid: string } }

		expect(result.params.uuid).toBe(uuid)
	})

	it("drive case with empty uuid: returns object shape with empty uuid", () => {
		const result = buildStartScreenHref("drive", "") as { pathname: string; params: { uuid: string } }

		expect(result.pathname).toBe("/tabs/drive/[uuid]")
		expect(result.params.uuid).toBe("")
	})
})
