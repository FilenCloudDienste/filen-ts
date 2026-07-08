import { describe, expect, it } from "vitest"
import { canShareVariant } from "@/lib/share/gating"

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
