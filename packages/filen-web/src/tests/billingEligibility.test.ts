import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { UserAccountSubs, UserInfo } from "@filen/sdk-rs"
import {
	cancelAvailableFrom,
	CANCEL_DELAY_MS,
	eligibleWithdrawals,
	isCancellable,
	isRecurringStripe,
	isWithdrawalEligible,
	nextBillingChange,
	toMillis,
	withCancelled,
	withdrawalEndsAt,
	withdrawalLanguage,
	withdrawalNamePrefill,
	withWithdrawal
} from "@/features/settings/lib/billing"

// A zone with DST, so the window's calendar arithmetic is tested across a clock change.
const previousTz = process.env["TZ"]

beforeAll(() => {
	process.env["TZ"] = "Europe/Berlin"
})

afterAll(() => {
	if (previousTz === undefined) {
		delete process.env["TZ"]
	} else {
		process.env["TZ"] = previousTz
	}
})

function sub(overrides: Partial<UserAccountSubs>): UserAccountSubs {
	return {
		id: "sub-1",
		planId: 27n,
		planName: "Pro I",
		planCost: 1.99,
		gateway: "stripe",
		storage: 1n,
		activated: true,
		cancelled: false,
		startTimestamp: BigInt(new Date(2026, 10, 9, 15, 30).getTime()),
		...overrides
	}
}

function withoutStart(): UserAccountSubs {
	const s = sub({})

	delete s.startTimestamp

	return s
}

function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
	return new Date(year, month, day, hour, minute, second, ms).getTime()
}

describe("withdrawal window", () => {
	it("ends at the end of the local calendar day of start + 14 days", () => {
		const s = sub({})

		expect(withdrawalEndsAt(s)).toBe(local(2026, 10, 24))
		expect(isWithdrawalEligible(s, local(2026, 10, 23, 23, 59, 59, 999))).toBe(true)
		expect(isWithdrawalEligible(s, local(2026, 10, 24))).toBe(false)
	})

	it("counts calendar days across a DST change, not 24 h blocks", () => {
		// 20 March 2026 23:30, the last Sunday of March (29th) springs forward.
		const s = sub({ startTimestamp: BigInt(local(2026, 2, 20, 23, 30)) })

		expect(withdrawalEndsAt(s)).toBe(local(2026, 3, 4))
		expect(new Date(local(2026, 3, 4) - 1).getDate()).toBe(3)
		expect(isWithdrawalEligible(s, local(2026, 3, 3, 23, 59))).toBe(true)
		expect(isWithdrawalEligible(s, local(2026, 3, 4, 0, 0, 1))).toBe(false)
	})

	it("handles the autumn change too", () => {
		// 20 October 2026 00:10; the clocks go back on 25 October.
		const s = sub({ startTimestamp: BigInt(local(2026, 9, 20, 0, 10)) })

		expect(withdrawalEndsAt(s)).toBe(local(2026, 10, 4))
	})

	it("needs an activated subscription without a prior request and a known start", () => {
		const now = local(2026, 10, 10)

		expect(isWithdrawalEligible(sub({ activated: false }), now)).toBe(false)
		expect(isWithdrawalEligible(sub({ withdrawRequested: 1n }), now)).toBe(false)
		expect(isWithdrawalEligible(withoutStart(), now)).toBe(false)
	})

	it("keeps cancelled and lifetime purchases eligible", () => {
		const now = local(2026, 10, 10)

		expect(isWithdrawalEligible(sub({ cancelled: true }), now)).toBe(true)
		expect(isWithdrawalEligible(sub({ gateway: "stripe_sale", planName: "Pro lifetime" }), now)).toBe(true)
	})

	it("lists eligible subscriptions earliest deadline first", () => {
		const late = sub({ id: "late", startTimestamp: BigInt(local(2026, 10, 9)) })
		const early = sub({ id: "early", startTimestamp: BigInt(local(2026, 10, 1)) })
		const done = sub({ id: "done", withdrawRequested: 5n })

		expect(eligibleWithdrawals([late, done, early], local(2026, 10, 10)).map(s => s.id)).toEqual(["early", "late"])
	})
})

describe("cancel rules", () => {
	it("offers cancel only for live recurring stripe or paypal subscriptions", () => {
		expect(isCancellable(sub({}))).toBe(true)
		expect(isCancellable(sub({ gateway: "paypal" }))).toBe(true)
		expect(isCancellable(sub({ gateway: "stripe_sale" }))).toBe(false)
		expect(isCancellable(sub({ gateway: "paypal_sale" }))).toBe(false)
		expect(isCancellable(sub({ gateway: "crypto" }))).toBe(false)
		expect(isCancellable(sub({ cancelled: true }))).toBe(false)
		expect(isCancellable(sub({ activated: false }))).toBe(false)
	})

	it("is held back for a day after the start", () => {
		const s = sub({})
		const start = Number(s.startTimestamp)

		expect(cancelAvailableFrom(s, start + 1000)).toBe(start + CANCEL_DELAY_MS)
		expect(cancelAvailableFrom(s, start + CANCEL_DELAY_MS)).toBeUndefined()
		expect(cancelAvailableFrom(withoutStart(), start)).toBeUndefined()
	})

	it("links the card portal only for the recurring card gateway", () => {
		expect(isRecurringStripe(sub({}))).toBe(true)
		expect(isRecurringStripe(sub({ gateway: "stripe_sale" }))).toBe(false)
		expect(isRecurringStripe(sub({ gateway: "paypal" }))).toBe(false)
	})
})

describe("nextBillingChange", () => {
	it("is the nearest of a closing window and a cancel becoming available", () => {
		const s = sub({})
		const start = Number(s.startTimestamp)

		expect(nextBillingChange([s], start + 1000)).toBe(start + CANCEL_DELAY_MS)
		expect(nextBillingChange([s], start + CANCEL_DELAY_MS)).toBe(withdrawalEndsAt(s))
		expect(nextBillingChange([s], local(2026, 10, 25))).toBeUndefined()
	})
})

describe("helpers", () => {
	it("reads bigint millis and absent values", () => {
		expect(toMillis(5n)).toBe(5)
		expect(toMillis(undefined)).toBeUndefined()
	})

	it("mails the receipt in German only for a German UI", () => {
		expect(withdrawalLanguage("de")).toBe("de")
		expect(withdrawalLanguage("de-AT")).toBe("de")
		expect(withdrawalLanguage("en")).toBe("en")
		expect(withdrawalLanguage("fr")).toBe("en")
	})

	it("prefills the name from personal info, then the display name, then the nickname", () => {
		const base = { displayName: "", nickName: undefined, personal: { firstName: undefined, lastName: undefined } }

		expect(withdrawalNamePrefill({ ...base, personal: { firstName: " Jane ", lastName: "Doe" } } as unknown as UserInfo)).toBe(
			"Jane Doe"
		)
		expect(withdrawalNamePrefill({ ...base, displayName: "J. Doe" } as unknown as UserInfo)).toBe("J. Doe")
		expect(withdrawalNamePrefill({ ...base, nickName: "jd" } as unknown as UserInfo)).toBe("jd")
		expect(withdrawalNamePrefill(base as unknown as UserInfo)).toBe("")
	})

	it("patches one subscription", () => {
		const subs = [sub({ id: "a" }), sub({ id: "b" })]

		expect(withWithdrawal(subs, "b", 9n).map(s => s.withdrawRequested)).toEqual([undefined, 9n])
		expect(withCancelled(subs, "a").map(s => s.cancelled)).toEqual([true, false])
	})
})
