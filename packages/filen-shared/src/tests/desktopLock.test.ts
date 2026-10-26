import { describe, expect, it } from "vitest"
import { DESKTOP_PIN_MAX_LENGTH, DESKTOP_PIN_MIN_LENGTH, desktopPinSchema } from "@filen/shared/desktopLock"

describe("desktopPinSchema", () => {
	it("accepts digit strings within the length bounds", () => {
		expect(desktopPinSchema.allows("1".repeat(DESKTOP_PIN_MIN_LENGTH))).toBe(true)
		expect(desktopPinSchema.allows("0".repeat(DESKTOP_PIN_MAX_LENGTH))).toBe(true)
	})

	it("rejects anything else", () => {
		expect(desktopPinSchema.allows("1".repeat(DESKTOP_PIN_MIN_LENGTH - 1))).toBe(false)
		expect(desktopPinSchema.allows("1".repeat(DESKTOP_PIN_MAX_LENGTH + 1))).toBe(false)
		expect(desktopPinSchema.allows("12a4")).toBe(false)
		expect(desktopPinSchema.allows("1234\n")).toBe(false)
		expect(desktopPinSchema.allows("١٢٣٤")).toBe(false)
		expect(desktopPinSchema.allows(1234)).toBe(false)
	})
})
