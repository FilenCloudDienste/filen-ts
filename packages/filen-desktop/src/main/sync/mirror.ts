import type { NativePair } from "../../shared/nativeProtocol.ts"
import { stripVerbatim } from "./localRoot.ts"
import type { ShellPair } from "./store.ts"

// The id the bridge knows a pair by: the engine's, or a stable stand-in while the engine does not hold it (the old
// client's uuid; else the remote directory, which no two engine pairs share).
export function shellPairId(pair: ShellPair): string {
	return pair.pairId ?? (pair.legacyUuid !== null ? `legacy:${pair.legacyUuid}` : `remote:${pair.remoteRoot}`)
}

// Case is folded since the remote directory already keeps two pairs apart.
export function rootKey(localRoot: string, remoteRoot: string): string {
	return `${stripVerbatim(localRoot).toLowerCase()}\0${remoteRoot.toLowerCase()}`
}

export function basename(localRoot: string): string {
	const segments = localRoot.split(/[\\/]/).filter(segment => segment.length > 0)

	return segments.at(-1) ?? localRoot
}

export interface Reconciled {
	pairs: ShellPair[]
	// Pairs a baseline reset lost, or a re-add left unfinished: to be added again, paused, through the first-run guard.
	// Their `paused` is what the user had.
	readd: ShellPair[]
}

// Run on every `ready`: the engine's pairs win. Matched by roots (a reset engine numbers its pairs afresh); the
// engine's id, local root, mode and paused flag replace the mirror's (a preparing pair keeps what the user had), the
// shell's own fields stay. An engine pair the mirror lacks gets its directory's name. A mirror pair the engine lacks
// is gone (removed elsewhere, or a crash between the two writes) unless the engine never held it (no engine id);
// after a reset it is re-added instead.
export function reconcileMirror(
	pairs: readonly ShellPair[],
	enginePairs: readonly NativePair[],
	options: { reset: boolean; now: number }
): Reconciled {
	const engineByRoots = new Map(enginePairs.map(pair => [rootKey(pair.localRoot, pair.remoteRoot), pair]))
	const next: ShellPair[] = []
	const readd: ShellPair[] = []

	for (const pair of pairs) {
		const key = rootKey(pair.localRoot, pair.remoteRoot)
		const engine = engineByRoots.get(key)

		if (engine !== undefined) {
			engineByRoots.delete(key)
			next.push({
				...pair,
				pairId: engine.id,
				localRoot: engine.localRoot,
				mode: engine.mode,
				paused: pair.state === "preparing" ? pair.paused : engine.paused,
				state: pair.state === "review" || pair.state === "preparing" ? pair.state : "active"
			})
		} else if (pair.state === "waitingForRoot" || pair.state === "unsupported") {
			next.push(pair)
		} else if (options.reset || pair.pairId === null) {
			const lost = { ...pair, pairId: null }

			next.push(lost)
			readd.push(lost)
		}
	}

	for (const engine of engineByRoots.values()) {
		next.push({
			pairId: engine.id,
			name: basename(engine.localRoot),
			localRoot: engine.localRoot,
			remoteRoot: engine.remoteRoot,
			mode: engine.mode,
			paused: engine.paused,
			state: "active",
			review: null,
			legacyUuid: null,
			legacyRules: null,
			notices: [],
			rootProblem: null,
			holds: [],
			wholeDriveConfirmed: false,
			info: [],
			createdAt: options.now
		})
	}

	return { pairs: next, readd }
}
