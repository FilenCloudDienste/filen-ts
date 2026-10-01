import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { applyUpdate } from "@/lib/sw/register"
import { hasUnloadHold } from "@/lib/unloadGuard"
import { isBuildStillDeployed, staleBuildAction } from "@/lib/appUpdate.logic"

// One id, so a service-worker update and a failed worker start in the same tab raise a single prompt.
const UPDATE_TOAST_ID = "app-update"
const RELOAD_AT_KEY = "filen.staleBuildReloadAt"
// A run of failures (a directory of broken PDFs) asks the server once, not once per file.
const CHECK_INTERVAL_MS = 60_000

// The page is one bundle, so the file this module was loaded from names the running build.
const RUNNING_BUNDLE = new URL(import.meta.url).pathname

let lastCheckAt = 0

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

// Called when a worker the page starts after boot (PDF, spreadsheet, HEIC) fails. If index.html no longer
// loads this tab's bundle, a newer build replaced the worker's file: reload into it, or ask first while
// something holds the tab. Any other failure (a broken file, no network) leaves the tab as it is. Dev
// serves source modules rather than one bundle, so only a production build checks.
export function recoverIfNewerBuild(): void {
	const now = Date.now()

	if (!import.meta.env.PROD || now - lastCheckAt < CHECK_INTERVAL_MS) {
		return
	}

	lastCheckAt = now

	void fetch("/", { cache: "no-cache" })
		.then(async response => (response.ok ? await response.text() : null))
		.then(html => {
			if (html === null || isBuildStillDeployed(html, RUNNING_BUNDLE)) {
				return
			}

			const at = Date.now()
			const action = staleBuildAction({ busy: hasUnloadHold(), lastReloadAt: readReloadAt(), now: at })

			if (action === "prompt") {
				showUpdateReadyToast()
			} else if (action === "reload") {
				writeReloadAt(at)
				location.reload()
			}
		})
		.catch(() => {
			// Unreachable server: nothing to compare against, and a reload could not load either.
		})
}
