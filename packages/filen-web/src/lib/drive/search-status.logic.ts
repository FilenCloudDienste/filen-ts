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

// No snapshot at all within this window of opening collapses to terminal — a wedged worker can't
// spin a bare "Searching…" forever.
export const WATCHDOG_MS = 15_000

// Backstop for a dropped resync-finished push: stop waiting on a stalled convergence after this long
// and finalize on whatever landed.
export const STALL_CEILING_MS = 30_000

// Whole-set single window (mobile parity) — see search-engine.ts's own CEILING; re-exported here only
// as documentation of the number this status machine's "background"/"searching-empty" states are
// tracking convergence toward, not an input to deriveSearchStatus itself.
export const RESULT_CEILING = 1_000

export interface SearchStatusInput {
	query: string
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

	// Zero results is warming until grace clears it — mirrors mobile's rule that a non-empty result
	// always displays immediately, grace only ever gates the empty case.
	if (input.resultCount === 0 && !input.graceElapsed) {
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
