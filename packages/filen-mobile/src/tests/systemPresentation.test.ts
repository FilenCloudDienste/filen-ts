import { describe, it, expect, vi } from "vitest"
import {
	SystemPresentation,
	withSystemPresentation,
	systemPresentation,
	reLockSuppressed,
	RELOCK_SUPPRESSION_GRACE_MS
} from "@/lib/systemPresentation"

describe("reLockSuppressed", () => {
	it("is suppressed while a presentation is active (any positive count)", () => {
		expect(reLockSuppressed(1, 0, 9_999_999)).toBe(true)
		expect(reLockSuppressed(3, 0, 9_999_999)).toBe(true)
	})

	it("is suppressed within the grace window after release", () => {
		expect(reLockSuppressed(0, 1000, 1000)).toBe(true)
		expect(reLockSuppressed(0, 1000, 1000 + RELOCK_SUPPRESSION_GRACE_MS - 1)).toBe(true)
	})

	it("is not suppressed once the grace window has elapsed", () => {
		expect(reLockSuppressed(0, 1000, 1000 + RELOCK_SUPPRESSION_GRACE_MS)).toBe(false)
		expect(reLockSuppressed(0, 1000, 1000 + RELOCK_SUPPRESSION_GRACE_MS + 5000)).toBe(false)
	})
})

describe("SystemPresentation", () => {
	it("ref-counts begin/end and reports isActive", async () => {
		const sp = new SystemPresentation()

		expect(sp.isActive()).toBe(false)
		await sp.begin()
		expect(sp.isActive()).toBe(true)
		await sp.begin()
		expect(sp.isActive()).toBe(true)
		await sp.end()
		expect(sp.isActive()).toBe(true)
		await sp.end()
		expect(sp.isActive()).toBe(false)
	})

	it("calls the suppressor only on the 0->1 and 1->0 transitions", async () => {
		const sp = new SystemPresentation()
		const suppressor = vi.fn().mockResolvedValue(undefined)
		sp.registerSuppressor(suppressor)

		await sp.begin()
		await sp.begin()
		expect(suppressor).toHaveBeenCalledTimes(1)
		expect(suppressor).toHaveBeenLastCalledWith(true)

		await sp.end()
		expect(suppressor).toHaveBeenCalledTimes(1)

		await sp.end()
		expect(suppressor).toHaveBeenCalledTimes(2)
		expect(suppressor).toHaveBeenLastCalledWith(false)
	})

	it("end() is a no-op when already inactive (never goes negative)", async () => {
		const sp = new SystemPresentation()
		const suppressor = vi.fn().mockResolvedValue(undefined)
		sp.registerSuppressor(suppressor)

		await sp.end()
		expect(sp.isActive()).toBe(false)
		expect(suppressor).not.toHaveBeenCalled()
	})

	it("unregister stops further suppressor calls", async () => {
		const sp = new SystemPresentation()
		const suppressor = vi.fn().mockResolvedValue(undefined)
		const unregister = sp.registerSuppressor(suppressor)

		unregister()
		await sp.begin()
		await sp.end()
		expect(suppressor).not.toHaveBeenCalled()
	})

	it("isReLockSuppressed is true while active and within grace after release", async () => {
		const sp = new SystemPresentation()

		await sp.begin()
		expect(sp.isReLockSuppressed()).toBe(true)
		await sp.end()
		expect(sp.isReLockSuppressed()).toBe(true)
		expect(sp.isReLockSuppressed(Date.now() + RELOCK_SUPPRESSION_GRACE_MS + 5000)).toBe(false)
	})

	it("swallows a throwing suppressor (begin/end never reject)", async () => {
		const sp = new SystemPresentation()
		sp.registerSuppressor(vi.fn().mockRejectedValue(new Error("native fail")))

		await expect(sp.begin()).resolves.toBeUndefined()
		await expect(sp.end()).resolves.toBeUndefined()
		expect(sp.isActive()).toBe(false)
	})
})

describe("withSystemPresentation", () => {
	it("brackets fn with begin/end and returns the result", async () => {
		const result = await withSystemPresentation(async () => {
			expect(systemPresentation.isActive()).toBe(true)

			return 42
		})

		expect(result).toBe(42)
		expect(systemPresentation.isActive()).toBe(false)
	})

	it("ends even when fn throws", async () => {
		await expect(
			withSystemPresentation(async () => {
				expect(systemPresentation.isActive()).toBe(true)

				throw new Error("boom")
			})
		).rejects.toThrow("boom")

		expect(systemPresentation.isActive()).toBe(false)
	})
})
