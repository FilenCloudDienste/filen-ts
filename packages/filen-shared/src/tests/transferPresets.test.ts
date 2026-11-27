import { describe, it, expect } from "vitest"
import {
	DEFAULT_TRANSFER_PERFORMANCE_PRESET,
	DESKTOP_WEB_TRANSFER_PRESET_VALUES,
	FULL_CHUNK_BYTES,
	TRANSFER_PRESET_VALUES,
	clampCustomConcurrency,
	desktopWebTransferValues,
	mobileTransferValues
} from "@filen/shared"

describe("TRANSFER_PRESET_VALUES", () => {
	it("maps the five tiers to their concurrency + memoryMib values", () => {
		expect(TRANSFER_PRESET_VALUES).toEqual({
			slowConnection: { concurrency: 2, memoryMib: 4 },
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
			slowConnection: { chunks: 4, concurrency: 2, rateLimitPerSec: 64 },
			batterySaver: { chunks: 8, concurrency: 12, rateLimitPerSec: 64 },
			balanced: { chunks: 32, concurrency: 48, rateLimitPerSec: 160 },
			performance: { chunks: 64, concurrency: 96, rateLimitPerSec: 320 },
			maximum: { chunks: 128, concurrency: 160, rateLimitPerSec: 640 }
		})
	})

	it("buffers at least four chunks on every preset", () => {
		for (const values of Object.values(DESKTOP_WEB_TRANSFER_PRESET_VALUES)) {
			expect(values.chunks).toBeGreaterThanOrEqual(4)
		}
	})

	it("counts a full chunk with its encryption overhead", () => {
		expect(FULL_CHUNK_BYTES).toBe(1_048_604)
	})
})

describe("custom transfer values", () => {
	it("returns a preset's own values for a preset", () => {
		expect(desktopWebTransferValues("balanced", 3)).toBe(DESKTOP_WEB_TRANSFER_PRESET_VALUES.balanced)
		expect(mobileTransferValues("maximum", 3)).toBe(TRANSFER_PRESET_VALUES.maximum)
	})

	it("runs exactly the custom count of chunks, with at least four buffered and the covering preset's rate", () => {
		expect(desktopWebTransferValues("custom", 1)).toEqual({ chunks: 4, concurrency: 1, rateLimitPerSec: 64 })
		expect(desktopWebTransferValues("custom", 13)).toEqual({ chunks: 13, concurrency: 13, rateLimitPerSec: 160 })
		expect(desktopWebTransferValues("custom", 160)).toEqual({ chunks: 160, concurrency: 160, rateLimitPerSec: 640 })
		expect(mobileTransferValues("custom", 1)).toEqual({ concurrency: 1, memoryMib: 4 })
		expect(mobileTransferValues("custom", 20)).toEqual({ concurrency: 20, memoryMib: 20 })
	})

	it("keeps a custom count within 1 and the ladder's maximum", () => {
		expect(desktopWebTransferValues("custom", 0).concurrency).toBe(1)
		expect(desktopWebTransferValues("custom", 999).concurrency).toBe(160)
		expect(mobileTransferValues("custom", 999).concurrency).toBe(32)
		expect(clampCustomConcurrency(2.6, 32, 8)).toBe(3)
		expect(clampCustomConcurrency("x", 32, 8)).toBe(8)
		expect(clampCustomConcurrency(Number.NaN, 32, 8)).toBe(8)
	})
})
