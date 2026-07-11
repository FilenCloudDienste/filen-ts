import { describe, expect, it } from "vitest"
import {
	tierLabelKey,
	referralLink,
	referralEarnedStorage,
	formatBillingCost,
	formatBillingDate,
	subscriptionStatus
} from "@/features/settings/lib/billing"

describe("tierLabelKey (account-plans-stack rule: derived from isPremium only)", () => {
	it("Free for a non-premium account", () => {
		expect(tierLabelKey(false)).toBe("settingsBillingTierFree")
	})

	it("Pro for a premium account, regardless of how many plans are stacked", () => {
		expect(tierLabelKey(true)).toBe("settingsBillingTierPro")
	})
})

describe("referralLink", () => {
	it("builds the filen.io referral URL from refId", () => {
		expect(referralLink("abc123")).toBe("https://filen.io/r/abc123")
	})
})

describe("referralEarnedStorage", () => {
	it("returns referStorage unchanged when under the refStorage*refLimit cap", () => {
		expect(referralEarnedStorage(10n, 5n, 20n)).toBe(20n)
	})

	it("clamps to the cap once referStorage exceeds refStorage*refLimit", () => {
		expect(referralEarnedStorage(10n, 5n, 999n)).toBe(50n)
	})

	it("is exactly the cap at the boundary (not clamped, not off-by-one)", () => {
		expect(referralEarnedStorage(10n, 5n, 50n)).toBe(50n)
	})
})

describe("formatBillingCost", () => {
	it("formats a plain number as a euro amount with two decimals", () => {
		expect(formatBillingCost(9.9)).toBe("€9.90")
		expect(formatBillingCost(0)).toBe("€0.00")
	})
})

describe("formatBillingDate", () => {
	it("formats an ISO-8601 DateTime<Utc> string into a short localized date", () => {
		expect(formatBillingDate("2026-01-15T00:00:00Z")).toMatch(/2026/)
	})
})

describe("subscriptionStatus", () => {
	it("cancelled wins over activated", () => {
		expect(subscriptionStatus({ activated: true, cancelled: true })).toBe("cancelled")
	})

	it("active when activated and not cancelled", () => {
		expect(subscriptionStatus({ activated: true, cancelled: false })).toBe("active")
	})

	it("pending when neither activated nor cancelled", () => {
		expect(subscriptionStatus({ activated: false, cancelled: false })).toBe("pending")
	})
})
