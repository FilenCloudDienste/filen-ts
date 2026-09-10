import type { AnyFile } from "@filen/sdk-rs"
import { registerWithSw } from "@/features/drive/lib/saveDownload"
import { SW_DOWNLOAD_PREFIX, SW_MSG_REGISTER_PREVIEW } from "@/lib/sw/protocol"

// Registers `file` against the SW's inline-preview route (no attachment disposition, an allowlisted
// Content-Type, Range/206-capable) and returns its fetchable, same-origin URL — the src a
// <video>/<audio>/<img> element streams+seeks against directly. Rides saveDownload.ts's shared
// registration seam (session handoff + restart healing), minus the FSA branch and the plain-navigation
// trigger: an inline media element just needs a stable URL, it never "saves" anything.
export async function previewStreamUrl(file: AnyFile, name: string, contentType: string): Promise<string> {
	const id = crypto.randomUUID()

	await registerWithSw(SW_MSG_REGISTER_PREVIEW, { id, file, name, size: Number(file.size), contentType })

	return `${SW_DOWNLOAD_PREFIX}${id}`
}

// Capability gate: true once a service worker is actually controlling this tab — registered in every
// mode now (dev serves the worker's source module, see lib/sw/register.ts), so this is true once boot
// has claimed the page and false only before that. This is the single flip point every
// streamed viewer branches on before ever calling previewStreamUrl — if inline streaming ever proves
// unreliable in a real browser, forcing this false alone reroutes every viewer to the buffered blob
// fallback, no other call site needs to change.
export function isMediaStreamAvailable(): boolean {
	return "serviceWorker" in navigator && navigator.serviceWorker.controller !== null
}

// How long to let a registered-but-unclaimed worker finish taking control. A page is uncontrolled for
// a moment after every install and update, so this is the ordinary first-load state, not an error.
const SW_CONTROL_TIMEOUT_MS = 5_000

// The awaitable form of the gate above, for callers that would otherwise treat "not yet" as "no".
// Returns immediately in both settled cases: true when a worker already controls the tab, false when
// none is REGISTERED at all, so a browser without one pays nothing rather than burning the timeout on
// every item its caller looks at. Only the genuinely transient case waits.
export async function waitForMediaStream(timeoutMs: number = SW_CONTROL_TIMEOUT_MS): Promise<boolean> {
	if (isMediaStreamAvailable()) {
		return true
	}

	if (!("serviceWorker" in navigator)) {
		return false
	}

	const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)

	if (registration === undefined) {
		return false
	}

	return await new Promise<boolean>(resolve => {
		function settle(value: boolean): void {
			clearTimeout(timer)
			navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
			resolve(value)
		}

		function onControllerChange(): void {
			if (navigator.serviceWorker.controller !== null) {
				settle(true)
			}
		}

		const timer = setTimeout(() => {
			settle(false)
		}, timeoutMs)

		navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)

		// Re-checked after the listener is attached: control can land in the gap between the early
		// return above and this subscription, and controllerchange does not replay.
		onControllerChange()
	})
}
