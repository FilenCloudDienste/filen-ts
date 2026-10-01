import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { applyUpdate } from "@/lib/sw/register"
import { hasUnloadHold } from "@/lib/unloadGuard"
import { staleChunkAction } from "@/lib/appUpdate.logic"

// One id, so a service-worker update and a stale chunk in the same tab raise a single prompt.
const UPDATE_TOAST_ID = "app-update"
const RELOAD_AT_KEY = "filen.staleChunkReloadAt"

export function showUpdateReadyToast(): void {
	toast(i18n.t("updateReadyTitle"), {
		id: UPDATE_TOAST_ID,
		description: i18n.t("updateReadyBody"),
		duration: Infinity,
		action: { label: i18n.t("reload"), onClick: applyUpdate }
	})
}

function readReloadAt(): number | null {
	try {
		const value = sessionStorage.getItem(RELOAD_AT_KEY)

		return value === null ? null : Number(value)
	} catch {
		return null
	}
}

function writeReloadAt(now: number): void {
	try {
		sessionStorage.setItem(RELOAD_AT_KEY, String(now))
	} catch {
		// Without storage the cooldown cannot hold, but one reload into the new build is still right.
	}
}

// Vite raises vite:preloadError when a lazily imported chunk fails to load. Left uncancelled, the import
// still rejects, so whatever renders the failure stays in place until the reload replaces the page.
export function installStaleChunkRecovery(): void {
	window.addEventListener("vite:preloadError", () => {
		const now = Date.now()
		const action = staleChunkAction({ online: navigator.onLine, busy: hasUnloadHold(), lastReloadAt: readReloadAt(), now })

		if (action === "prompt") {
			showUpdateReadyToast()
		} else if (action === "reload") {
			writeReloadAt(now)
			location.reload()
		}
	})
}
