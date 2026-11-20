import { desktopBridge } from "@/lib/desktop"
import { WEB_APP_ORIGIN } from "@/lib/webApp"

// Plans, checkout and every billing mutation exist only in the web app; the desktop app sends people there. The
// bridge never changes mid-session; read per call so it stays a plain lookup.
export function isDesktopBilling(): boolean {
	return desktopBridge() !== undefined
}

export const WEB_BILLING_URL = `${WEB_APP_ORIGIN}/settings/billing`

// The Plans page's target: `plan` preselects a plan by its config id (/settings/plans/<plan>).
export interface PlansTarget {
	plan?: number
}

export function parsePlanId(value: unknown): number | undefined {
	const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value

	return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const PLANS_PATH_RE = /^\/settings\/plans(?:\/([^/]+))?\/?$/

// The Plans page a pathname opens, or null for any other page. A malformed plan id is dropped, never the page.
export function plansTargetOfPath(pathname: string): PlansTarget | null {
	const m = PLANS_PATH_RE.exec(pathname)

	if (m === null) {
		return null
	}

	const plan = parsePlanId(m[1])

	return plan === undefined ? {} : { plan }
}

// Desktop: the system browser (the window-open handler hands any https URL to it).
export function openWebBilling(): void {
	window.open(WEB_BILLING_URL, "_blank", "noopener,noreferrer")
}
