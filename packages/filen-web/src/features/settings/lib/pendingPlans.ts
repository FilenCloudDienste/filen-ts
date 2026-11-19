import { parsePlanId, type PlansSearch } from "@/features/settings/lib/billingLinks"
import { log } from "@/lib/log"

// A plans link opened while signed out (a pricing-page link, the desktop app's billing link) waits here through
// sign-in or registration and its email confirmation, in this tab only.
const PENDING_PLANS_KEY = "filen.pendingPlans"
// Any other page of the app opened while signed out (a bookmark, a link to a note or a directory), kept the same way.
const PENDING_TARGET_KEY = "filen.pendingTarget"
// Only parses relative paths; never navigated to.
const PARSE_BASE = "https://return.invalid"

export function rememberPlansTarget(plan: number | undefined): void {
	try {
		sessionStorage.setItem(PENDING_PLANS_KEY, plan === undefined ? "" : String(plan))
	} catch (e) {
		log.warn("billing", "remembering the plans link failed", e)
	}
}

function takeItem(key: string): string | null {
	try {
		const raw = sessionStorage.getItem(key)

		sessionStorage.removeItem(key)

		return raw
	} catch (e) {
		log.warn("auth", "reading a pending sign-in target failed", e)

		return null
	}
}

// Read once: the target is cleared as it is taken.
export function takePlansTarget(): PlansSearch | null {
	const raw = takeItem(PENDING_PLANS_KEY)

	if (raw === null) {
		return null
	}

	const plan = parsePlanId(raw)

	return plan === undefined ? {} : { plan }
}

// The URL parser drops tabs and newlines, which would turn "/\t/host" into a protocol-relative "//host".
function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)

		if (code < 0x20 || code === 0x7f) {
			return true
		}
	}

	return false
}

// A path inside this app, or null: one leading slash, no backslash or control character, and no scheme or host once
// parsed, so a stored value can never send sign-in to another site.
export function safeReturnPath(value: string): string | null {
	if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || hasControlCharacter(value)) {
		return null
	}

	try {
		const url = new URL(value, PARSE_BASE)

		return url.origin === PARSE_BASE ? `${url.pathname}${url.search}${url.hash}` : null
	} catch {
		return null
	}
}

// A sign-out ends in a reload of the page it left, and so does another tab's; a history step back or forward can
// return to the previous account's pages. Only a fresh navigation (a link, a bookmark, a typed address) carries its
// place to the next sign-in. Without the timing entry the load is treated as fresh.
function documentIsFreshNavigation(): boolean {
	try {
		const [entry] = performance.getEntriesByType("navigation")

		return entry === undefined || !("type" in entry) || entry.type === "navigate"
	} catch {
		return true
	}
}

export function rememberReturnTarget(href: string): void {
	const path = safeReturnPath(href)

	if (path === null || !documentIsFreshNavigation()) {
		return
	}

	try {
		sessionStorage.setItem(PENDING_TARGET_KEY, path)
	} catch (e) {
		log.warn("auth", "remembering the page to return to failed", e)
	}
}

export type SignInTarget = { kind: "plans"; search: PlansSearch } | { kind: "path"; href: string }

// Where a fresh sign-in goes, read once: the plans first, else the page that asked for it. Both are taken, so neither
// outlives the sign-in. Another account's ids under the path resolve to the page's own empty state.
export function takeSignInTarget(): SignInTarget | null {
	const plans = takePlansTarget()
	const raw = takeItem(PENDING_TARGET_KEY)

	if (plans !== null) {
		return { kind: "plans", search: plans }
	}

	const href = raw === null ? null : safeReturnPath(raw)

	return href === null ? null : { kind: "path", href }
}
