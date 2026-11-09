import { parsePlanId, type PlansSearch } from "@/features/settings/lib/billingLinks"
import { log } from "@/lib/log"

// A plans link opened while signed out (a pricing-page link, the desktop app's billing link) waits here through
// sign-in or registration and its email confirmation, in this tab only.
const PENDING_PLANS_KEY = "filen.pendingPlans"

export function rememberPlansTarget(plan: number | undefined): void {
	try {
		sessionStorage.setItem(PENDING_PLANS_KEY, plan === undefined ? "" : String(plan))
	} catch (e) {
		log.warn("billing", "remembering the plans link failed", e)
	}
}

// Read once: the target is cleared as it is taken.
export function takePlansTarget(): PlansSearch | null {
	let raw: string | null = null

	try {
		raw = sessionStorage.getItem(PENDING_PLANS_KEY)
		sessionStorage.removeItem(PENDING_PLANS_KEY)
	} catch (e) {
		log.warn("billing", "reading the plans link failed", e)
	}

	if (raw === null) {
		return null
	}

	const plan = parsePlanId(raw)

	return plan === undefined ? {} : { plan }
}
