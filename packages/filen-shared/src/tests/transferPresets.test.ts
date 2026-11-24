import { describe, it, expect } from "vitest"
import {
	DEFAULT_TRANSFER_PERFORMANCE_PRESET,
	DESKTOP_WEB_TRANSFER_PRESET_VALUES,
	FULL_CHUNK_BYTES,
	TRANSFER_PRESET_VALUES
} from "@filen/shared"

describe("TRANSFER_PRESET_VALUES", () => {
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
	it("is 'balanced'", () => {
		expect(DEFAULT_TRANSFER_PERFORMANCE_PRESET).toBe("balanced")
	})
})

describe("DESKTOP_WEB_TRANSFER_PRESET_VALUES", () => {
	it("pins the web and desktop ladder", () => {
		expect(DESKTOP_WEB_TRANSFER_PRESET_VALUES).toEqual({
			batterySaver: { chunks: 8, concurrency: 12, rateLimitPerSec: 64 },
			balanced: { chunks: 32, concurrency: 48, rateLimitPerSec: 160 },
			performance: { chunks: 64, concurrency: 96, rateLimitPerSec: 320 },
			maximum: { chunks: 128, concurrency: 160, rateLimitPerSec: 640 }
		})
	})

	it("leaves every preset more requests than chunks, so listings still get through", () => {
		for (const values of Object.values(DESKTOP_WEB_TRANSFER_PRESET_VALUES)) {
			expect(values.concurrency).toBeGreaterThan(values.chunks)
		}
	})

	it("counts a full chunk with its encryption overhead", () => {
		expect(FULL_CHUNK_BYTES).toBe(1_048_604)
	})
})
