import { desktopBridge } from "@/lib/desktop"
import { WEB_APP_ORIGIN } from "@/lib/webApp"

// Plans, checkout and every billing mutation exist only in the web app; the desktop app sends people there. The
// bridge never changes mid-session; read per call so it stays a plain lookup.
export function isDesktopBilling(): boolean {
	return desktopBridge() !== undefined
}

export const WEB_BILLING_URL = `${WEB_APP_ORIGIN}/settings/billing`

// The Plans route's search: `plan` preselects a plan by its config id.
export interface PlansSearch {
	plan?: number
}

export function parsePlanId(value: unknown): number | undefined {
	const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value

	return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function validatePlansSearch(search: Record<string, unknown>): PlansSearch {
	const plan = parsePlanId(search["plan"])

	return plan === undefined ? {} : { plan }
}

// Desktop: the system browser (the window-open handler hands any https URL to it).
export function openWebBilling(): void {
	window.open(WEB_BILLING_URL, "_blank", "noopener,noreferrer")
}
