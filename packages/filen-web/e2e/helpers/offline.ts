import type { Page } from "@playwright/test"

// Playwright's `context.setOffline` is ADVISORY for this app. It flips `navigator.onLine` and cuts the
// page's own fetches, but every SDK request leaves from the wasm thread pool's nested workers, which the
// emulation never reaches — playwright-core skips worker sessions outright (crNetworkManager's
// `_setOfflineForSession`: `if (info.workerFrame) return`) and Chromium does not inherit a frame's
// emulated conditions into a worker's own children. Measured on this build: with the context offline,
// the SDK's `/v3/chat/*` reads still answered 200.
//
// What DOES gate the app's outboxes is TanStack's `onlineManager`, which moves only on the window
// online/offline EVENT. Firing that event shuts the gate deterministically: the evaluate resolves only
// once the listener has run, so every enqueue after it happens against an outbox that provably cannot
// push. Alone it leaves the context online, and a fresh boot seeds the manager from navigator.onLine,
// so the next boot's replay pushes.
export async function dispatchAppConnectivity(page: Page, offline: boolean): Promise<void> {
	await page.evaluate(isOffline => {
		window.dispatchEvent(new Event(isOffline ? "offline" : "online"))
	}, offline)
}

export async function setAppOffline(page: Page, offline: boolean): Promise<void> {
	await page.context().setOffline(offline)
	await dispatchAppConnectivity(page, offline)
}
