import { vi, describe, it, expect } from "vitest"

// PublicLinkExpiration is a uniffi-generated numeric enum. The helpers under
// test only use it as a comparable value via ===, so we stub the module with
// plain numeric constants that mirror the real ordinals.
vi.mock("@filen/sdk-rs", () => ({
	PublicLinkExpiration: {
		Never: 0,
		OneHour: 1,
		SixHours: 2,
		OneDay: 3,
		ThreeDays: 4,
		OneWeek: 5,
		TwoWeeks: 6,
		ThirtyDays: 7
	}
}))

import { PublicLinkExpiration } from "@filen/sdk-rs"
import { isExpirationChecked, isPublicLinkQueryError } from "@/features/publicLink/utils"

describe("isExpirationChecked", () => {
	it("returns true for the edited value when an edited selection is present", () => {
		expect(
			isExpirationChecked({
				candidate: PublicLinkExpiration.OneWeek,
				editedExpiration: PublicLinkExpiration.OneWeek,
				serverExpiration: PublicLinkExpiration.Never
			})
		).toBe(true)
	})

	it("returns false for the server value when an edited selection differs from it", () => {
		expect(
			isExpirationChecked({
				candidate: PublicLinkExpiration.Never,
				editedExpiration: PublicLinkExpiration.OneWeek,
				serverExpiration: PublicLinkExpiration.Never
			})
		).toBe(false)
	})

	it("returns false for a value that matches neither edited nor server", () => {
		expect(
			isExpirationChecked({
				candidate: PublicLinkExpiration.ThirtyDays,
				editedExpiration: PublicLinkExpiration.OneWeek,
				serverExpiration: PublicLinkExpiration.Never
			})
		).toBe(false)
	})

	it("falls back to server value when no edited selection is present", () => {
		expect(
			isExpirationChecked({
				candidate: PublicLinkExpiration.Never,
				editedExpiration: undefined,
				serverExpiration: PublicLinkExpiration.Never
			})
		).toBe(true)
	})

	it("returns false for a non-matching candidate when only server value is present", () => {
		expect(
			isExpirationChecked({
				candidate: PublicLinkExpiration.OneDay,
				editedExpiration: undefined,
				serverExpiration: PublicLinkExpiration.Never
			})
		).toBe(false)
	})

	it("returns false when both edited and server are undefined", () => {
		expect(
			isExpirationChecked({
				candidate: PublicLinkExpiration.Never,
				editedExpiration: undefined,
				serverExpiration: undefined
			})
		).toBe(false)
	})

	it("exactly one candidate is checked across all options when edited is set (no double-check)", () => {
		const allValues = [
			PublicLinkExpiration.Never,
			PublicLinkExpiration.OneHour,
			PublicLinkExpiration.SixHours,
			PublicLinkExpiration.OneDay,
			PublicLinkExpiration.ThreeDays,
			PublicLinkExpiration.OneWeek,
			PublicLinkExpiration.TwoWeeks,
			PublicLinkExpiration.ThirtyDays
		]

		const editedExpiration = PublicLinkExpiration.OneWeek
		const serverExpiration = PublicLinkExpiration.Never

		const checked = allValues.filter(candidate =>
			isExpirationChecked({
				candidate,
				editedExpiration,
				serverExpiration
			})
		)

		expect(checked).toHaveLength(1)
		expect(checked[0]).toBe(PublicLinkExpiration.OneWeek)
	})

	it("exactly one candidate is checked when no edited value is present", () => {
		const allValues = [
			PublicLinkExpiration.Never,
			PublicLinkExpiration.OneHour,
			PublicLinkExpiration.SixHours,
			PublicLinkExpiration.OneDay,
			PublicLinkExpiration.ThreeDays,
			PublicLinkExpiration.OneWeek,
			PublicLinkExpiration.TwoWeeks,
			PublicLinkExpiration.ThirtyDays
		]

		const serverExpiration = PublicLinkExpiration.ThirtyDays

		const checked = allValues.filter(candidate =>
			isExpirationChecked({
				candidate,
				editedExpiration: undefined,
				serverExpiration
			})
		)

		expect(checked).toHaveLength(1)
		expect(checked[0]).toBe(PublicLinkExpiration.ThirtyDays)
	})
})

describe("isPublicLinkQueryError", () => {
	it("returns true when publicLinkStatus is error", () => {
		expect(isPublicLinkQueryError("error", "success")).toBe(true)
	})

	it("returns true when account is error", () => {
		expect(isPublicLinkQueryError("success", "error")).toBe(true)
	})

	it("returns true when both are error", () => {
		expect(isPublicLinkQueryError("error", "error")).toBe(true)
	})

	it("returns false when both are pending", () => {
		expect(isPublicLinkQueryError("pending", "pending")).toBe(false)
	})

	it("returns false when both are success", () => {
		expect(isPublicLinkQueryError("success", "success")).toBe(false)
	})

	it("returns false when one is success and the other is pending", () => {
		expect(isPublicLinkQueryError("success", "pending")).toBe(false)
		expect(isPublicLinkQueryError("pending", "success")).toBe(false)
	})
})
