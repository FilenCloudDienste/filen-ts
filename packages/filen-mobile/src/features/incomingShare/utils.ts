// Spinner gate for the incoming-share screen. The expo-sharing hook exposes no explicit
// "resolution finished" signal, and an empty resolved list is ambiguous between three states:
// still waiting for the post-commit resolve effect, resolution completed with nothing usable,
// and nothing shared at all. Deriving the spinner from the resolved list alone wedged the
// screen forever whenever the native parsers dropped a share (empty list, no error) — so the
// gate spins only while resolution is running or genuinely still pending: the sync-parsed
// payload list is non-empty (something WAS shared, resolution will run) and no resolution
// attempt has completed yet. Everything else renders the list/empty/error states.
export function isIncomingShareLoading({
	isResolving,
	hasError,
	sharedCount,
	resolvedCount,
	hasResolvedOnce
}: {
	isResolving: boolean
	hasError: boolean
	sharedCount: number
	resolvedCount: number
	hasResolvedOnce: boolean
}): boolean {
	if (isResolving) {
		return true
	}

	if (hasError) {
		return false
	}

	return sharedCount > 0 && resolvedCount === 0 && !hasResolvedOnce
}

/**
 * What the screen offers for the resolved payloads.
 *
 * The confirm button and the offline notice are two halves of ONE decision: the notice exists
 * precisely to explain the button's absence while offline (#104), which is the state the screen
 * shipped in without it — an upload screen with no action and nothing saying why. Derived together
 * rather than from two independent conditions that could drift into showing both, or neither.
 */
export type IncomingShareAction = "confirm" | "offlineNotice" | "none"

export function incomingShareAction({ hasPayloads, isOnline }: { hasPayloads: boolean; isOnline: boolean }): IncomingShareAction {
	// Nothing to save: the list renders its own empty/error state, and an offline notice there would
	// blame connectivity for a share that produced no files.
	if (!hasPayloads) {
		return "none"
	}

	return isOnline ? "confirm" : "offlineNotice"
}
