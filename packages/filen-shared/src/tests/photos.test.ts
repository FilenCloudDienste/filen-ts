import { describe, it, expect } from "vitest"
import { CAPTURE_TIMESTAMP_FLOOR, estimateCaptureTimestamp } from "@filen/shared"

describe("CAPTURE_TIMESTAMP_FLOOR", () => {
	it("is exactly 1980-01-01 UTC", () => {
		expect(CAPTURE_TIMESTAMP_FLOOR).toBe(Date.UTC(1980, 0, 1))
	})
})

describe("estimateCaptureTimestamp", () => {
	const UPLOADED = 1_700_000_000_000

	it("falls back to the upload timestamp when neither created nor modified is usable", () => {
		expect(estimateCaptureTimestamp(UPLOADED)).toBe(UPLOADED)
	})

	it("prefers a qualifying created over the upload timestamp", () => {
		const created = 1_600_000_000_000n

		expect(estimateCaptureTimestamp(UPLOADED, created)).toBe(Number(created))
	})

	it("takes the MINIMUM of created and modified when both qualify", () => {
		const created = 1_600_000_000_000n
		const modified = 1_500_000_000_000n

		expect(estimateCaptureTimestamp(UPLOADED, created, modified)).toBe(Number(modified))
	})

	it("clamps out a candidate ABOVE the upload timestamp (a photo can't be modified before it was captured, but a bogus future client stamp is still garbage)", () => {
		const futureCreated = BigInt(UPLOADED) + 1_000n

		expect(estimateCaptureTimestamp(UPLOADED, futureCreated)).toBe(UPLOADED)
	})

	it("clamps out a candidate exactly at the floor (floor is exclusive: value > FLOOR, not >=)", () => {
		const atFloor = BigInt(CAPTURE_TIMESTAMP_FLOOR)

		expect(estimateCaptureTimestamp(UPLOADED, atFloor)).toBe(UPLOADED)
	})

	it("clamps out a candidate below the floor (legacy epoch-zero garbage)", () => {
		expect(estimateCaptureTimestamp(UPLOADED, 0n)).toBe(UPLOADED)
	})

	it("accepts a candidate exactly one ms above the floor", () => {
		const justAboveFloor = BigInt(CAPTURE_TIMESTAMP_FLOOR) + 1n

		expect(estimateCaptureTimestamp(UPLOADED, justAboveFloor)).toBe(Number(justAboveFloor))
	})

	it("accepts a candidate exactly equal to the upload timestamp (<=, not <)", () => {
		expect(estimateCaptureTimestamp(UPLOADED, BigInt(UPLOADED))).toBe(UPLOADED)
	})

	it("modified alone (no created) qualifies exactly like created alone", () => {
		const modified = 1_600_000_000_000n

		expect(estimateCaptureTimestamp(UPLOADED, undefined, modified)).toBe(Number(modified))
	})

	it("a disqualified created still lets a qualifying modified win", () => {
		const disqualifiedCreated = BigInt(UPLOADED) + 1_000n // above uploaded, clamped out
		const qualifyingModified = 1_600_000_000_000n

		expect(estimateCaptureTimestamp(UPLOADED, disqualifiedCreated, qualifyingModified)).toBe(Number(qualifyingModified))
	})
})
