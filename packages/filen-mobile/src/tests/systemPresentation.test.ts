import { describe, it, expect, beforeEach } from "vitest"
import {
	useSystemPresentationStore,
	systemPresentation,
	withSystemPresentation,
	reLockSuppressed,
	RELOCK_SUPPRESSION_GRACE_MS
} from "@/lib/systemPresentation"

beforeEach(() => {
	useSystemPresentationStore.setState({ activeCount: 0, lastEndedAt: 0 })
})

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

describe("systemPresentation begin/end", () => {
	it("ref-counts and reports isActive", () => {
		expect(systemPresentation.isActive()).toBe(false)

		systemPresentation.begin()
		expect(systemPresentation.isActive()).toBe(true)
		expect(useSystemPresentationStore.getState().activeCount).toBe(1)

		systemPresentation.begin()
		expect(useSystemPresentationStore.getState().activeCount).toBe(2)

		systemPresentation.end()
		expect(systemPresentation.isActive()).toBe(true)

		systemPresentation.end()
		expect(systemPresentation.isActive()).toBe(false)
	})

	it("end() is a no-op at zero (never goes negative)", () => {
		systemPresentation.end()
		expect(useSystemPresentationStore.getState().activeCount).toBe(0)
	})

	it("records lastEndedAt on the 1->0 transition for the grace window", () => {
		systemPresentation.begin()
		systemPresentation.end()

		expect(systemPresentation.isReLockSuppressed()).toBe(true)
		expect(systemPresentation.isReLockSuppressed(Date.now() + RELOCK_SUPPRESSION_GRACE_MS + 5000)).toBe(false)
	})

	it("starts the grace window only on the 1->0 transition, not on 2->1", () => {
		systemPresentation.begin()
		systemPresentation.begin()
		systemPresentation.end()

		// still one presentation active → no grace recorded yet
		expect(useSystemPresentationStore.getState().lastEndedAt).toBe(0)
		expect(systemPresentation.isActive()).toBe(true)

		systemPresentation.end()

		// now fully released → grace window starts
		expect(useSystemPresentationStore.getState().lastEndedAt).toBeGreaterThan(0)
	})

	it("isActive reflects active presentations regardless of the grace window", () => {
		systemPresentation.begin()
		expect(systemPresentation.isActive()).toBe(true)

		systemPresentation.end()
		expect(systemPresentation.isActive()).toBe(false)
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
