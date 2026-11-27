import { describe, expect, it, vi } from "vitest"
import { createSpeedApplier, speedConfig } from "../native/speed.ts"
import { SPEED } from "./nativeFakes.ts"

function speedClient() {
	return {
		setConcurrency: vi.fn(() => Promise.resolve()),
		setRequestRateLimit: vi.fn(() => Promise.resolve()),
		setFileIoMemoryBudget: vi.fn(() => Promise.resolve()),
		setBandwidthLimits: vi.fn(() => Promise.resolve())
	}
}

describe("speedConfig", () => {
	it("maps a preset to its concurrency, request rate and whole-chunk budget, limits as given", () => {
		expect(speedConfig({ preset: "balanced", customConcurrency: 48, uploadKbps: 0, downloadKbps: 0 })).toEqual({
			concurrency: 48,
			rateLimitPerSec: 160,
			fileIoMemoryBudget: BigInt(32 * 1_048_604),
			uploadBandwidthKilobytesPerSec: 0,
			downloadBandwidthKilobytesPerSec: 0
		})
		expect(speedConfig({ preset: "maximum", customConcurrency: 48, uploadKbps: 1, downloadKbps: 1 })).toMatchObject({
			concurrency: 160,
			uploadBandwidthKilobytesPerSec: 16,
			downloadBandwidthKilobytesPerSec: 1
		})
	})

	it("runs a custom count of chunks, buffering at least four", () => {
		expect(speedConfig({ preset: "custom", customConcurrency: 2, uploadKbps: 0, downloadKbps: 0 })).toMatchObject({
			concurrency: 2,
			rateLimitPerSec: 64,
			fileIoMemoryBudget: BigInt(4 * 1_048_604)
		})
		expect(speedConfig({ preset: "slowConnection", customConcurrency: 48, uploadKbps: 0, downloadKbps: 0 }).concurrency).toBe(2)
	})
})

describe("createSpeedApplier", () => {
	it("applies each client's own speed through its setters, skipping a client that did not change", async () => {
		const sync = speedClient()
		const transfers = speedClient()
		const warn = vi.fn()
		const applier = createSpeedApplier({ sync, transfers }, SPEED, { warn })

		await applier.apply({ ...SPEED, sync: { preset: "batterySaver", customConcurrency: 48, uploadKbps: 100, downloadKbps: 0 } })

		expect(sync.setConcurrency).toHaveBeenCalledWith(12)
		expect(sync.setRequestRateLimit).toHaveBeenCalledWith(64)
		expect(sync.setFileIoMemoryBudget).toHaveBeenCalledWith(BigInt(8 * 1_048_604))
		expect(sync.setBandwidthLimits).toHaveBeenCalledWith(100, 0)
		expect(transfers.setConcurrency).not.toHaveBeenCalled()

		// The same again: nothing to apply.
		await applier.apply({ ...SPEED, sync: { preset: "batterySaver", customConcurrency: 48, uploadKbps: 100, downloadKbps: 0 } })
		expect(sync.setConcurrency).toHaveBeenCalledOnce()
		expect(warn).not.toHaveBeenCalled()
	})

	it("logs a setter's rejection and still applies the others", async () => {
		const sync = speedClient()
		const warn = vi.fn()

		sync.setFileIoMemoryBudget.mockRejectedValueOnce(new Error("budget below the minimum"))

		const applier = createSpeedApplier({ sync, transfers: speedClient() }, SPEED, { warn })

		await expect(
			applier.apply({ ...SPEED, sync: { preset: "maximum", customConcurrency: 48, uploadKbps: 0, downloadKbps: 0 } })
		).resolves.toBeUndefined()
		expect(sync.setBandwidthLimits).toHaveBeenCalledWith(0, 0)
		expect(warn).toHaveBeenCalledWith("sync speed not applied: budget below the minimum")
	})

	it("keeps an older addon's clients as built, logging once, never throwing", async () => {
		const warn = vi.fn()
		const applier = createSpeedApplier({ sync: {}, transfers: {} }, SPEED, { warn })
		const changed = {
			sync: { preset: "maximum" as const, customConcurrency: 48, uploadKbps: 1, downloadKbps: 1 },
			transfers: { preset: "maximum" as const, customConcurrency: 48, uploadKbps: 1, downloadKbps: 1 }
		}

		await expect(applier.apply(changed)).resolves.toBeUndefined()
		await expect(applier.apply({ ...changed, sync: SPEED.sync })).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalledOnce()
		expect(warn).toHaveBeenCalledWith("the addon has no speed setters: speed changes apply at the next start")
	})
})
