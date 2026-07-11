import type { UserAccountSubs } from "@filen/sdk-rs"
import type { SettingsKey } from "@/lib/i18n"

// The account-plans-stack rule (project memory: Filen accounts can stack multiple, even different,
// plans to combine their total storage — a single plan/sub name is never a tier label): derive Free
// vs. Pro from `isPremium` ONLY, never from `plans`/`subs[].planName`. Table rows below still show a
// subscription's own real `planName` — that rule is about a SINGLE headline tier label, not about
// hiding what a stacked subscription actually is in its own row.
export function tierLabelKey(isPremium: boolean): SettingsKey {
	return isPremium ? "settingsBillingTierPro" : "settingsBillingTierFree"
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

// Plan/invoice cost fields are a plain `number` with no currency field on the wasm type — filen.io
// bills in EUR (verified against old-web's invoices table, which hard-codes the same "€" suffix).
export function formatBillingCost(cost: number): string {
	return `€${cost.toFixed(2)}`
}

// `DateTime<Utc>` crosses wasm-bindgen as a plain ISO-8601 string (sdk-rs-shims.d.ts) — `new Date()`
// parses that natively, no bigint-millis conversion needed (unlike every other timestamp field on this
// app's wasm types).
export function formatBillingDate(value: string): string {
	return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
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

export const SUBSCRIPTION_STATUS_LABEL_KEY = {
	active: "settingsBillingStatusActive",
	cancelled: "settingsBillingStatusCancelled",
	pending: "settingsBillingStatusPending"
} satisfies Record<SubscriptionStatus, SettingsKey>
