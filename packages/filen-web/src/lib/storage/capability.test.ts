import { afterEach, describe, expect, it, vi } from "vitest"
import { isOpfsApiAvailable } from "@/lib/storage/capability"

// Stateless pure function — no module-level state to reset between cases, unlike register.test.ts's
// freshRegisterModule() dance, so a plain vi.stubGlobal per test (undone in afterEach) is enough.
afterEach(() => {
	vi.unstubAllGlobals()
})

describe("isOpfsApiAvailable", () => {
	it("true when navigator.storage.getDirectory is a function", () => {
		vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve() } })

		expect(isOpfsApiAvailable()).toBe(true)
	})

	it("false when navigator.storage is entirely absent (Firefox private windows, unsupported browsers)", () => {
		vi.stubGlobal("navigator", {})

		expect(isOpfsApiAvailable()).toBe(false)
	})

	it("false when navigator.storage exists but getDirectory is not a function", () => {
		vi.stubGlobal("navigator", { storage: {} })

		expect(isOpfsApiAvailable()).toBe(false)
	})
})
