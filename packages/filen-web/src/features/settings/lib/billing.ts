import type { UserAccountSubs, UserInfo } from "@filen/sdk-rs"
import type { SettingsKey } from "@/lib/i18n"

// The account-plans-stack rule (project memory: Filen accounts can stack multiple, even different,
// plans to combine their total storage — a single plan/sub name is never a tier label): derive Free
// vs. Pro from `isProAccount(subs)` (@filen/shared, the backend's own isUserPro rule) ONLY, never from
// `plans`/`subs[].planName` and never from the account's `isPremium` (set only by one-off purchases,
// never reset). Table rows below still show a subscription's own real `planName` — that rule is about a
// SINGLE headline tier label, not about hiding what a stacked subscription actually is in its own row.
export function tierLabelKey(isPro: boolean): SettingsKey {
	return isPro ? "settingsBillingTierPro" : "settingsBillingTierFree"
}

// `https://filen.io/r/<refId>` — verified against old-web's invite card, the one other surface that
// builds this link (this repo has no server endpoint of its own that mints it).
export function referralLink(refId: string): string {
	return `https://filen.io/r/${refId}`
}

// Earned referral storage is capped at `refStorage * refLimit` (storage-per-referral × the counted
// referral limit) — mirrors old-web's invite card: `referStorage` can keep growing past that cap
// server-side (more people sign up with the code) without the account actually earning more, so the
// display value clamps rather than showing a number the account never actually banks.
export function referralEarnedStorage(refStorage: bigint, refLimit: bigint, referStorage: bigint): bigint {
	const cap = refStorage * refLimit

	return referStorage > cap ? cap : referStorage
}

// Plan/invoice cost fields are a plain `number` with no currency field on the wasm type; filen.io bills in EUR.
// Number formatting follows the browser region.
const EUR = new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" })

export function formatBillingCost(cost: number): string {
	return EUR.format(cost)
}

export type SubscriptionStatus = "active" | "cancelled" | "pending"

// A subscription's own three-state status: `cancelled` wins over `activated` (a cancelled sub can
// still show `activated: true` until its current billing period actually lapses — cancellation is the
// more actionable fact to surface), otherwise `activated` means live, otherwise still pending
// (payment not yet confirmed by the gateway).
export function subscriptionStatus(sub: Pick<UserAccountSubs, "activated" | "cancelled">): SubscriptionStatus {
	if (sub.cancelled) {
		return "cancelled"
	}

	return sub.activated ? "active" : "pending"
}

export const SUBSCRIPTION_STATUS_META = {
	active: { labelKey: "settingsBillingStatusActive", badge: "default" },
	cancelled: { labelKey: "settingsBillingStatusCancelled", badge: "destructive" },
	pending: { labelKey: "settingsBillingStatusPending", badge: "secondary" }
} as const satisfies Record<SubscriptionStatus, { labelKey: SettingsKey; badge: "default" | "destructive" | "secondary" }>

// Subscription timestamps arrive as bigint millis, absent when the server holds none.
export function toMillis(value: bigint | number | undefined): number | undefined {
	return value === undefined ? undefined : Number(value)
}

// The backend refuses a cancel within a day of the start.
export const CANCEL_DELAY_MS = 24 * 60 * 60 * 1000

type CancelFields = Pick<UserAccountSubs, "activated" | "cancelled" | "gateway" | "startTimestamp">

// Only recurring gateways can be cancelled: one-off purchases (lifetime, crypto) carry other gateway names.
export function isCancellable(sub: CancelFields): boolean {
	return sub.activated && !sub.cancelled && (sub.gateway === "stripe" || sub.gateway === "paypal")
}

// When Cancel becomes available, undefined when it already is.
export function cancelAvailableFrom(sub: Pick<UserAccountSubs, "startTimestamp">, now: number): number | undefined {
	const start = toMillis(sub.startTimestamp)

	if (start === undefined) {
		return undefined
	}

	const from = start + CANCEL_DELAY_MS

	return from > now ? from : undefined
}

// The recurring card subscription has a self-service portal; one-off card purchases ("stripe_sale") do not.
export function isRecurringStripe(sub: Pick<UserAccountSubs, "gateway">): boolean {
	return sub.gateway === "stripe"
}

export const STRIPE_BILLING_PORTAL_URL = "https://billing.stripe.com/p/login/6oE9Bl8Lxey0ayI9AA"

export const WITHDRAWAL_DAYS = 14

type WithdrawalFields = Pick<UserAccountSubs, "activated" | "startTimestamp" | "withdrawRequested">

// The moment the withdrawal window closes (exclusive): the end of the local calendar day of start + 14 days.
// Built from calendar fields, so a DST change inside the window moves no deadline.
export function withdrawalEndsAt(sub: Pick<UserAccountSubs, "startTimestamp">): number | undefined {
	const start = toMillis(sub.startTimestamp)

	if (start === undefined) {
		return undefined
	}

	const day = new Date(start)

	return new Date(day.getFullYear(), day.getMonth(), day.getDate() + WITHDRAWAL_DAYS + 1).getTime()
}

// Cancelled and lifetime subscriptions stay eligible: the backend checks only activation and a prior request.
export function isWithdrawalEligible(sub: WithdrawalFields, now: number): boolean {
	if (!sub.activated || sub.withdrawRequested !== undefined) {
		return false
	}

	const endsAt = withdrawalEndsAt(sub)

	return endsAt !== undefined && now < endsAt
}

// Earliest deadline first, so a single entry point preselects the most urgent one.
export function eligibleWithdrawals<T extends WithdrawalFields>(subs: readonly T[], now: number): T[] {
	return subs.filter(sub => isWithdrawalEligible(sub, now)).sort((a, b) => (withdrawalEndsAt(a) ?? 0) - (withdrawalEndsAt(b) ?? 0))
}

// The next moment eligibility changes on its own (a window closing, or Cancel becoming available), for one timer.
export function nextBillingChange(subs: readonly UserAccountSubs[], now: number): number | undefined {
	let next: number | undefined

	for (const sub of subs) {
		const candidates = [isWithdrawalEligible(sub, now) ? withdrawalEndsAt(sub) : undefined, cancelAvailableFrom(sub, now)]

		for (const at of candidates) {
			if (at !== undefined && at > now && (next === undefined || at < next)) {
				next = at
			}
		}
	}

	return next
}

// The receipt is mailed in German or English only.
export function withdrawalLanguage(uiLanguage: string): "de" | "en" {
	return uiLanguage.toLowerCase().startsWith("de") ? "de" : "en"
}

export function withdrawalNamePrefill(info: Pick<UserInfo, "personal" | "displayName" | "nickName">): string {
	const full = [info.personal.firstName, info.personal.lastName]
		.map(part => part?.trim() ?? "")
		.filter(part => part !== "")
		.join(" ")

	if (full !== "") {
		return full
	}

	return info.displayName.trim() || (info.nickName?.trim() ?? "")
}

export const WITHDRAWAL_NAME_MAX_LENGTH = 255

// Applies a received withdrawal to the cached subscriptions.
export function withWithdrawal(subs: readonly UserAccountSubs[], subId: string, at: bigint): UserAccountSubs[] {
	return subs.map(sub => (sub.id === subId ? { ...sub, withdrawRequested: at } : sub))
}

export function withCancelled(subs: readonly UserAccountSubs[], subId: string): UserAccountSubs[] {
	return subs.map(sub => (sub.id === subId ? { ...sub, cancelled: true } : sub))
}
