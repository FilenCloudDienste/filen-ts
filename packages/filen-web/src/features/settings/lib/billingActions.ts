import { onlineManager } from "@tanstack/react-query"
import type { UserAccountSubs, UserAccountSubsInvoices } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, ErrorWithDTO, plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { i18n, type SettingsKey } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadBlob } from "@/lib/downloadBlob"
import type { ActionOutcome, VoidActionOutcome } from "@/lib/actions/outcome"
import { accountQueryUpdate, fetchAccountFresh } from "@/queries/account"
import { withCancelled, withWithdrawal } from "@/features/settings/lib/billing"
import type { PaymentMethod } from "@/features/settings/lib/plans"

// Every billing write needs the server right now (nothing queues), so each one refuses offline here as well as in
// the component that offers it.
function offlineOutcome(): { status: "error"; dto: ErrorDTO } {
	return { status: "error", dto: plainErrorDTO(i18n.t("common:offlineActionDisabled"), "Offline") }
}

// The server's codes for billing refusals, worded for the person; anything else takes the general label.
const SERVER_CODE_LABELS: ReadonlyMap<string, SettingsKey> = new Map([
	["cannot_cancel_sub_now", "settingsBillingErrorCannotCancel"],
	["cannot_withdraw_sub_now", "settingsBillingErrorCannotWithdraw"],
	["sub_not_found", "settingsBillingErrorSubNotFound"],
	["invoice_not_found", "settingsBillingErrorInvoiceNotFound"],
	["plan_not_found", "settingsBillingErrorPlanUnavailable"],
	["plan_not_active", "settingsBillingErrorPlanUnavailable"],
	["invalid_plan_for_method", "settingsBillingErrorMethodUnavailable"],
	["rate_limited", "settingsBillingErrorRateLimited"],
	["invalid_params", "settingsBillingErrorInvalidParams"]
])

export function billingErrorLabel(error: unknown): string {
	const dto = asErrorDTO(error)
	const key = dto.serverCode === undefined ? undefined : SERVER_CODE_LABELS.get(dto.serverCode)

	return key === undefined ? errorLabel(dto) : i18n.t(`settings:${key}`)
}

export async function setAppearOffline(enabled: boolean): Promise<void> {
	if (!onlineManager.isOnline()) {
		throw new ErrorWithDTO(offlineOutcome().dto)
	}

	await sdkApi.setAppearOffline(enabled)
}

// Each checkout creates a gateway session (and, for one-off purchases, an unpaid invoice) and the server caps
// creates per hour, so a (plan, method) pair is created at most once per page and concurrent asks share one call.
const checkouts = new Map<string, Promise<ActionOutcome<string>>>()

function checkoutKey(planId: number, method: PaymentMethod): string {
	return `${String(planId)}:${method}`
}

// The URL already created for this pair, if any.
export function heldCheckout(planId: number, method: PaymentMethod): Promise<ActionOutcome<string>> | undefined {
	return checkouts.get(checkoutKey(planId, method))
}

// The URL becomes a link's href, so only a web page passes.
export function isCheckoutUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:"
	} catch {
		return false
	}
}

async function requestCheckout(planId: number, method: PaymentMethod): Promise<ActionOutcome<string>> {
	let url: string

	try {
		url = await sdkApi.createSubscription(planId, method)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return isCheckoutUrl(url)
		? { status: "success", item: url }
		: { status: "error", dto: plainErrorDTO("checkout URL is not https", "Server") }
}

export async function createCheckout(planId: number, method: PaymentMethod): Promise<ActionOutcome<string>> {
	const key = checkoutKey(planId, method)
	const held = checkouts.get(key)

	if (held !== undefined) {
		return held
	}

	if (!onlineManager.isOnline()) {
		return offlineOutcome()
	}

	const pending = requestCheckout(planId, method)

	checkouts.set(key, pending)

	const outcome = await pending

	// A refused create is not kept, so a retry asks again.
	if (outcome.status === "error") {
		checkouts.delete(key)
	}

	return outcome
}

// Tests only.
export function forgetCheckouts(): void {
	checkouts.clear()
}

export async function cancelSubscription(sub: Pick<UserAccountSubs, "id">): Promise<VoidActionOutcome> {
	if (!onlineManager.isOnline()) {
		return offlineOutcome()
	}

	try {
		await sdkApi.cancelSubscription(sub.id)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// The whole effect is known: no read back.
	accountQueryUpdate(prev => ({ ...prev, subs: withCancelled(prev.subs, sub.id) }), { readNow: false })

	return { status: "success" }
}

export interface WithdrawalRequest {
	subId: string
	name: string
	email: string
	lang: "de" | "en"
}

// "unconfirmed": the server reported an error after recording the withdrawal, so its confirmation email may be
// missing.
export type WithdrawalOutcome =
	{ status: "received"; at: bigint } | { status: "unconfirmed"; at: bigint } | { status: "error"; dto: ErrorDTO }

export async function withdrawSubscription(request: WithdrawalRequest): Promise<WithdrawalOutcome> {
	if (!onlineManager.isOnline()) {
		return offlineOutcome()
	}

	let at: bigint

	try {
		at = await sdkApi.withdrawSubscription(request.subId, request.name, request.email, request.lang)
	} catch (e) {
		return recheckWithdrawal(request.subId, asErrorDTO(e))
	}

	accountQueryUpdate(prev => ({ ...prev, subs: withWithdrawal(prev.subs, request.subId, at) }), { readNow: false })

	return { status: "received", at }
}

// One fresh read tells a refused withdrawal from one recorded before its mail step failed.
async function recheckWithdrawal(subId: string, dto: ErrorDTO): Promise<WithdrawalOutcome> {
	try {
		const info = await fetchAccountFresh()
		const at = info.subs.find(sub => sub.id === subId)?.withdrawRequested

		return at === undefined ? { status: "error", dto } : { status: "unconfirmed", at }
	} catch {
		return { status: "error", dto }
	}
}

export async function downloadInvoice(invoice: Pick<UserAccountSubsInvoices, "id">): Promise<VoidActionOutcome> {
	if (!onlineManager.isOnline()) {
		return offlineOutcome()
	}

	try {
		const bytes = await sdkApi.generateInvoice(invoice.id)

		downloadBlob(`Invoice_${invoice.id}.pdf`, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
}
