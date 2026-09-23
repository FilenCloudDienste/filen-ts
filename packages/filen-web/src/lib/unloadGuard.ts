// Navigations the app starts on purpose — a service-worker download (a plain navigation the SW turns
// into a file save without leaving the page) and the reloads that end a session — must not trip the
// leave-page prompt that guards running transfers. Consumed by the first prompt it covers and bounded
// in time, so it can never excuse a later, real close of the tab.
const ALLOWANCE_MS = 2_000

let allowedUntil = 0

export function allowNextUnload(): void {
	allowedUntil = Date.now() + ALLOWANCE_MS
}

export function consumeUnloadAllowance(): boolean {
	const allowed = Date.now() <= allowedUntil

	allowedUntil = 0

	return allowed
}

// The beforeunload listener while something must not be dropped by closing the tab. preventDefault()
// alone raises the prompt in every engine that can run this app; the deprecated returnValue isn't needed.
export function blockUnloadUnlessAllowed(event: Pick<BeforeUnloadEvent, "preventDefault">): void {
	if (consumeUnloadAllowance()) {
		return
	}

	event.preventDefault()
}
