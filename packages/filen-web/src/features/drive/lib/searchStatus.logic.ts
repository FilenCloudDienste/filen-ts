// Pure status machine for the cache-backed drive search — the reduced-signal port of the mobile
// app's own grace/watchdog framing (no "offline-incomplete": this app has no equivalent connectivity
// signal wired into search yet). Framework-free so the derivation is exhaustively table-tested
// without a worker, Comlink, or React; the hook that owns the actual timers is a later concern.
export type SearchStatus = "idle" | "warming" | "searching-empty" | "background" | "settled" | "terminal"

// Debounce before a keystroke reaches searchSetName (engine-local refilter — no network, no reopen).
export const SETCONFIG_DEBOUNCE_MS = 350

// Suppresses a "no results" flash within this window of an (re)open or the last resync heartbeat —
// an empty snapshot this fresh may just not have converged yet.
export const GRACE_MS = 400

// Past this much time with nothing back at all, give up and collapse to terminal. Deliberately a
// LAST resort, not a responsiveness knob: a first index over a large account can legitimately take
// minutes, and the engine's resync pushes are lossy (try_send) so a silent stretch does not imply a
// dead open — collapsing early misreports a slow-but-live search as failed.
export const WATCHDOG_MS = 180_000

// Backstop for a dropped resync-finished push: stop waiting on a stalled convergence after this long
// and finalize on whatever landed.
export const STALL_CEILING_MS = 30_000

// Whole-set single window (mobile parity) — see searchEngine.ts's own CEILING; re-exported here only
// as documentation of the number this status machine's "background"/"searching-empty" states are
// tracking convergence toward, not an input to deriveSearchStatus itself.
export const RESULT_CEILING = 1_000

export interface SearchStatusInput {
	query: string
	// True once the CURRENT open has produced at least one snapshot (even an empty one). The caller
	// must default this to false the instant an open is issued and flip it true only once a real
	// snapshot lands — never infer it from resultCount/graceElapsed alone (see the warming branch
	// below): a slow first round trip that outlasts the grace window must still read as warming, not
	// as a converged zero-result search.
	hasSnapshot: boolean
	resultCount: number
	resyncing: boolean
	live: boolean
	rootDeleted: boolean
	graceElapsed: boolean
	watchdogTripped: boolean
}

// `watchdogTripped` carries mobile's two ceilings (a pre-first-result watchdog and a post-result
// stall backstop) as ONE flag: the caller arms it with whichever duration fits the current state
// (WATCHDOG_MS with no data yet, STALL_CEILING_MS once results exist), re-armed on every resync
// heartbeat either way. Its effect on the derivation differs by that same state anyway — fatal
// (terminal) with no data and no resync in flight, a soft finalize (settled) once anything is
// actually converging or already on screen — so one flag reproduces both mobile states without a
// second boolean.
export function deriveSearchStatus(input: SearchStatusInput): SearchStatus {
	if (input.query.trim().length === 0) {
		return "idle"
	}

	if (!input.live || input.rootDeleted || (input.watchdogTripped && input.resultCount === 0 && !input.resyncing)) {
		return "terminal"
	}

	// No snapshot at all yet for the current open ALWAYS reads as warming, independent of the grace
	// timer — a caller that only relied on resultCount===0/graceElapsed defaults here would misread a
	// slow (but eventually successful) first round trip as a converged, empty search the instant grace
	// elapsed before the open even resolved. Once a snapshot has landed, zero results is warming only
	// until grace clears it — mirrors mobile's rule that a non-empty result always displays
	// immediately, grace only ever gates the empty case.
	if (!input.hasSnapshot || (input.resultCount === 0 && !input.graceElapsed)) {
		return "warming"
	}

	if (input.resultCount === 0 && input.resyncing && !input.watchdogTripped) {
		return "searching-empty"
	}

	if (input.resultCount > 0 && input.resyncing && !input.watchdogTripped) {
		return "background"
	}

	return "settled"
}

// Select-all is offered only once the result set has fully settled (or gone terminal/idle) — never
// while still warming up or background-resyncing, so the user can't "select all" a partial/still-
// growing window. Mirrors mobile's own select-all gate (see map-search.md #16); "terminal" and "idle"
// are excluded here even though they're not literal convergence states because the caller only ever
// calls this while a search is actually active, and neither reflects a still-growing result set.
export function isSearchConverging(status: SearchStatus): boolean {
	return status === "warming" || status === "searching-empty" || status === "background"
}
