import { toast } from "sonner"
import { type } from "arktype"
import { i18n } from "@/lib/i18n"
import { hasUnloadHold } from "@/lib/unloadGuard"
import { log } from "@/lib/log"

// Cross-tab coordination after a cache clear that open tabs keep using from memory (Videos, the query cache): every
// tab reloads to drop what it holds. A tab that holds something it must not lose (a transfer, an unsaved editor) asks
// instead of reloading.

const CACHES_CHANNEL = "filen.caches.v1"
const RELOAD_TOAST_ID = "caches-reload"
// What the clearing tab reports once its own reload landed, so the outcome is not lost to the reload.
const REPORT_KEY = "filen.cacheClearReport"

// Another tab may run another build, so what arrives is checked.
const cacheMessageSchema = type({ kind: "'cachesCleared'" })

type CacheMessage = typeof cacheMessageSchema.infer

let channel: BroadcastChannel | null = null

function cachesChannel(): BroadcastChannel {
	channel ??= new BroadcastChannel(CACHES_CHANNEL)

	return channel
}

function promptReload(message: string): void {
	toast(message, {
		id: RELOAD_TOAST_ID,
		duration: Infinity,
		action: {
			label: i18n.t("common:reload"),
			onClick: () => {
				location.reload()
			}
		}
	})
}

// Reloads when nothing holds the tab, asks otherwise. Returns whether the reload started.
function reloadWhenIdle(message: string): boolean {
	if (hasUnloadHold()) {
		promptReload(message)

		return false
	}

	location.reload()

	return true
}

// Other tabs only: a BroadcastChannel never delivers to the tab that posted.
export function onCachesClearedElsewhere(): () => void {
	const caches = cachesChannel()
	const listener = (event: MessageEvent<unknown>): void => {
		if (!(cacheMessageSchema(event.data) instanceof type.errors)) {
			reloadWhenIdle(i18n.t("settings:storageReloadOtherTab"))
		}
	}

	caches.addEventListener("message", listener)

	return () => {
		caches.removeEventListener("message", listener)
	}
}

const reportSchema = type({ message: "string", kind: "'success' | 'error' | 'info'" })

export type CacheClearReport = typeof reportSchema.infer

// Tells every other tab, then reloads this one (or asks, while something holds it). The reports are shown after the
// reload, or right away when the tab stays. Returns whether this tab reloads.
export function finishWithReload(reports: readonly CacheClearReport[]): boolean {
	cachesChannel().postMessage({ kind: "cachesCleared" } satisfies CacheMessage)

	if (!hasUnloadHold()) {
		try {
			sessionStorage.setItem(REPORT_KEY, JSON.stringify(reports))
		} catch {
			// Without storage the outcome toasts are lost to the reload; the page itself shows the cleared sizes.
		}
	}

	if (reloadWhenIdle(i18n.t("settings:storageReloadThisTab"))) {
		return true
	}

	showReports(reports)

	return false
}

export function showReports(reports: readonly CacheClearReport[]): void {
	for (const report of reports) {
		if (report.kind === "success") {
			toast.success(report.message)
		} else if (report.kind === "error") {
			toast.error(report.message)
		} else {
			toast.info(report.message)
		}
	}
}

// The outcome a reload carried over, once.
export function takeReportsAfterReload(): CacheClearReport[] {
	let raw: string | null

	try {
		raw = sessionStorage.getItem(REPORT_KEY)
		sessionStorage.removeItem(REPORT_KEY)
	} catch {
		return []
	}

	if (raw === null) {
		return []
	}

	let parsed: unknown

	try {
		parsed = JSON.parse(raw)
	} catch {
		return []
	}

	const reports = reportSchema.array()(parsed)

	if (reports instanceof type.errors) {
		log.warn("storage.caches", "dropping an unreadable clear report")

		return []
	}

	return reports
}
