import type {
	DesktopSyncHostState,
	DesktopSyncImportNote,
	DesktopSyncOverview,
	DesktopSyncPair,
	DesktopSyncPhase
} from "@filen/shared/desktop"
import type { NativePairRuntime } from "../../shared/nativeProtocol.ts"
import { shellPairId } from "./mirror.ts"
import type { ShellPair } from "./store.ts"

const NO_ISSUES = { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 }
const NOT_DEGRADED = { local: false, remote: false }

// What needs the user first wins: review, then an unreachable server, a failing pair, then activity.
function phaseOf(pair: ShellPair, live: NativePairRuntime | undefined, paused: boolean): DesktopSyncPhase {
	if (pair.state !== "active") {
		return pair.state
	}

	if (live === undefined) {
		return paused ? "paused" : "idle"
	}

	// A pass that tries the server again shows as syncing.
	if (live.halted === "offline") {
		return live.syncing ? "syncing" : paused ? "paused" : "offline"
	}

	if (live.lastError !== null) {
		return "error"
	}

	if (live.syncing) {
		return "syncing"
	}

	if (live.stage !== null && !paused) {
		return live.stage.kind
	}

	return paused ? "paused" : "idle"
}

// The mirror's pairs in its order, with what the host reports live; a pair the host has not reported (it is off, or
// the pair is not in the engine) shows its stored state.
export function mergeOverview(
	host: DesktopSyncHostState,
	runtime: readonly NativePairRuntime[],
	pairs: readonly ShellPair[],
	importNote: DesktopSyncImportNote | null
): DesktopSyncOverview {
	const live = new Map(runtime.map(entry => [entry.id, entry]))

	return {
		host,
		importNote,
		pairs: pairs.map((pair): DesktopSyncPair => {
			const entry = pair.pairId === null ? undefined : live.get(pair.pairId)
			const paused = entry?.paused ?? pair.paused

			return {
				id: shellPairId(pair),
				name: pair.name,
				localRoot: pair.localRoot,
				remoteRoot: pair.remoteRoot,
				mode: entry?.mode ?? pair.mode,
				paused,
				phase: phaseOf(pair, entry, paused),
				progress: entry?.progress ?? null,
				transfers: entry?.transfers ?? [],
				lastSyncedAt: entry?.lastSyncedAt ?? null,
				lastError: entry?.lastError ?? null,
				issues: entry?.issues ?? NO_ISSUES,
				degraded: entry?.degraded ?? NOT_DEGRADED,
				stage: entry?.stage ?? null,
				halted: entry?.halted ?? null,
				refused: entry?.refused ?? null,
				review: pair.review,
				notices: pair.notices,
				rootProblem: pair.rootProblem,
				holds: pair.holds,
				info: pair.info
			}
		})
	}
}
