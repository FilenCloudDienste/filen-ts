import { describe, expect, it } from "vitest"
import { canShareVariant, isSharedVariant } from "@/lib/share/gating"

describe("canShareVariant", () => {
	it("allows every owned surface (drive, recents, favorites, shared-with-others)", () => {
		expect(canShareVariant("drive")).toBe(true)
		expect(canShareVariant("recents")).toBe(true)
		expect(canShareVariant("favorites")).toBe(true)
		expect(canShareVariant("sharedOut")).toBe(true)
	})

	it("blocks trash (disposed items) and shared-with-me (items owned by someone else)", () => {
		expect(canShareVariant("trash")).toBe(false)
		expect(canShareVariant("sharedIn")).toBe(false)
	})
})

describe("isSharedVariant", () => {
	it("is true for both shared surfaces", () => {
		expect(isSharedVariant("sharedIn")).toBe(true)
		expect(isSharedVariant("sharedOut")).toBe(true)
	})

	it("is false for every owned/trash variant", () => {
		expect(isSharedVariant("drive")).toBe(false)
		expect(isSharedVariant("recents")).toBe(false)
		expect(isSharedVariant("favorites")).toBe(false)
		expect(isSharedVariant("trash")).toBe(false)
	})
})
