import { describe, it, expect } from "vitest"
import { TRANSFER_PERFORMANCE_PRESETS, DEFAULT_TRANSFER_PERFORMANCE_PRESET, TRANSFER_PRESET_VALUES } from "@filen/shared"

describe("TRANSFER_PRESET_VALUES", () => {
	it("has an entry for every preset in the ladder", () => {
		for (const preset of TRANSFER_PERFORMANCE_PRESETS) {
			expect(TRANSFER_PRESET_VALUES[preset]).toBeDefined()
		}
	})

	it("maps the four tiers to their concurrency + memoryMib values", () => {
		expect(TRANSFER_PRESET_VALUES).toEqual({
			batterySaver: { concurrency: 4, memoryMib: 4 },
			balanced: { concurrency: 8, memoryMib: 8 },
			performance: { concurrency: 16, memoryMib: 16 },
			maximum: { concurrency: 32, memoryMib: 32 }
		})
	})
})

describe("DEFAULT_TRANSFER_PERFORMANCE_PRESET", () => {
	it("is 'balanced' and is itself a valid preset", () => {
		expect(DEFAULT_TRANSFER_PERFORMANCE_PRESET).toBe("balanced")
		expect(TRANSFER_PERFORMANCE_PRESETS).toContain(DEFAULT_TRANSFER_PERFORMANCE_PRESET)
	})
})
