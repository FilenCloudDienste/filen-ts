import { describe, expect, it } from "vitest"
import { canShareVariant, isReadOnlySharedVariant } from "@/features/drive/lib/share/gating"

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

describe("isReadOnlySharedVariant", () => {
	it("is true only for sharedIn — items owned by someone else", () => {
		expect(isReadOnlySharedVariant("sharedIn")).toBe(true)
	})

	// sharedOut items are the caller's OWN, merely shared out to someone else — the owner toolbar
	// (rename/move/favorite/color/versions/publicLink/trash) applies exactly as it does in My Drive.
	it("is false for sharedOut — those items are the caller's own", () => {
		expect(isReadOnlySharedVariant("sharedOut")).toBe(false)
	})

	it("is false for every other owned/trash variant", () => {
		expect(isReadOnlySharedVariant("drive")).toBe(false)
		expect(isReadOnlySharedVariant("recents")).toBe(false)
		expect(isReadOnlySharedVariant("favorites")).toBe(false)
		expect(isReadOnlySharedVariant("trash")).toBe(false)
		expect(isReadOnlySharedVariant("links")).toBe(false)
	})
})
