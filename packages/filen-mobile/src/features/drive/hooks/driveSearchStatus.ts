// Pure status-machine for the cache-backed drive search, extracted from useDriveSearch so it can
// be unit-tested in isolation (no React, no native deps). The hook feeds it the current snapshot +
// timer flags and renders the returned status; see useDriveSearch for how each input is produced.
export type DriveSearchStatus = "idle" | "warming" | "searching-empty" | "background" | "settled" | "terminal" | "offline-incomplete"

// An online search is "complete enough" once it has a snapshot reporting matches — used to decide
// whether a connectivity-restore reopen is still needed.
export function isOnlineComplete(hasSnapshot: boolean, totalCount: number): boolean {
	return hasSnapshot && totalCount > 0
}

export function deriveStatus(input: {
	isCacheSearch: boolean
	live: boolean
	openError: boolean
	cacheUnavailable: boolean
	rootDeleted: boolean
	watchdogFired: boolean
	hasSnapshot: boolean
	isOnline: boolean
	totalCount: number
	resyncing: boolean
	graceElapsed: boolean
	stallCeilingHit: boolean
}): DriveSearchStatus {
	if (!input.isCacheSearch) {
		return "idle"
	}

	if (
		!input.live ||
		// openError means "the most recent open attempt failed and no snapshot has landed since"
		// — the hook clears it on every successful snapshot AND on a setName the engine accepts,
		// and a fresh query re-arms it. NOT `&& !hasSnapshot`: a failed FOREGROUND reopen must
		// surface as terminal even while a STALE pre-background snapshot is still in state
		// (hasSnapshot stays true — sessionKey excludes the foreground edge), or the failed reopen
		// would show those stale results forever with no error. The display is hidden on terminal.
		input.openError ||
		input.cacheUnavailable ||
		input.rootDeleted ||
		// `&& !resyncing`: a watchdog fire during an active resync (Started arrived, worker
		// alive) is not a wedge — stay warming. The watchdog effect also resets on every
		// progress heartbeat, so this mainly covers a brief tick gap after Started.
		(input.watchdogFired && !input.hasSnapshot && !input.resyncing)
	) {
		return "terminal"
	}

	if (!input.isOnline && input.totalCount === 0) {
		return "offline-incomplete"
	}

	// Warming (a bare spinner — we genuinely don't know yet): no snapshot at all, OR an empty
	// result still inside the grace window. Once grace elapses an empty-but-resyncing result is
	// NOT a bare spinner — see "searching-empty" below.
	if (!input.hasSnapshot || (input.totalCount === 0 && !input.graceElapsed && !input.stallCeilingHit)) {
		return "warming"
	}

	// Empty so far, grace elapsed, but a convergence resync is still streaming the subtree in: we
	// can't yet conclude "no results" (a match may still land), but a bare spinner for the whole
	// resync reads as a hang. Surface an explicit "no results yet, still searching" instead. The
	// stall ceiling collapses this to "settled" (a genuine, final no-results) on total silence.
	if (input.totalCount === 0 && input.resyncing && !input.stallCeilingHit) {
		return "searching-empty"
	}

	if (input.totalCount > 0 && input.resyncing && !input.stallCeilingHit) {
		return "background"
	}

	return "settled"
}
