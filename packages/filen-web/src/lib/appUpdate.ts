import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { applyUpdate } from "@/lib/sw/register"
import { hasUnloadHold } from "@/lib/unloadGuard"
import { desktopPlatform } from "@/lib/desktop"
import { isBuildStillDeployed, staleBuildAction } from "@/lib/appUpdate.logic"

// One id, so a service-worker update and a failed worker start in the same tab raise a single prompt.
const UPDATE_TOAST_ID = "app-update"
const RELOAD_AT_KEY = "filen.staleBuildReloadAt"
// A run of failures (a directory of broken PDFs) asks the server once, not once per file.
const CHECK_INTERVAL_MS = 60_000

// The page is one bundle, so the file this module was loaded from names the running build.
const RUNNING_BUNDLE = new URL(import.meta.url).pathname

let lastCheckAt = 0

// The desktop app ships its page inside the app and updates natively, so it never offers a page reload as an update.
export function showUpdateReadyToast(): void {
	if (desktopPlatform() !== undefined) {
		return
	}

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

// Long enough for index.html on a slow link; a hung request must not hold up what waits on the answer.
const PROBE_TIMEOUT_MS = 5000

export type BuildDeployment = "deployed" | "replaced" | "unknown"

// Whether the server still deploys this tab's build. Not known in dev (source modules, no bundle) or
// without the server.
export async function buildDeployment(): Promise<BuildDeployment> {
	if (!import.meta.env.PROD) {
		return "unknown"
	}

	try {
		const response = await fetch("/", { cache: "no-cache", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })

		if (!response.ok) {
			return "unknown"
		}

		return isBuildStillDeployed(await response.text(), RUNNING_BUNDLE) ? "deployed" : "replaced"
	} catch {
		// Unreachable server: nothing to compare against, and a reload could not load either.
		return "unknown"
	}
}

// A newer build is deployed: reload into it, or ask first while something holds the tab.
export function updateToNewerBuild(): void {
	const now = Date.now()
	const action = staleBuildAction({ busy: hasUnloadHold(), lastReloadAt: readReloadAt(), now })

	if (action === "prompt") {
		showUpdateReadyToast()
	} else if (action === "reload") {
		writeReloadAt(now)
		location.reload()
	}
}

// Called when a worker the page starts after boot (PDF, spreadsheet, HEIC) fails. If index.html no longer
// loads this tab's bundle, a newer build replaced the worker's file and the tab updates. Any other failure
// (a broken file, no network) leaves the tab as it is.
export function recoverIfNewerBuild(): void {
	const now = Date.now()

	if (!import.meta.env.PROD || now - lastCheckAt < CHECK_INTERVAL_MS) {
		return
	}

	lastCheckAt = now

	void buildDeployment().then(deployment => {
		if (deployment === "replaced") {
			updateToNewerBuild()
		}
	})
}
