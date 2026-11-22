import type { DesktopMountsError, DesktopMountsOverview, DesktopSyncOverview, DesktopSyncPair } from "./desktop"
import { formatBytes } from "./misc"
import { listRest, MAX_ARRAY_ITEMS } from "./assistant/budget"
import { matchScore, searchTokens } from "./assistant/search"

// get_desktop_status's result, from the overviews the desktop app already holds: the same rows in the app and in the
// eval's fake app. Pair names, local paths, remote names and error texts are the user's or other people's words; the
// result is declared `names` and the loop treats it so.

export const DESKTOP_ONLY_ERROR = "Sync and mounts are only in the desktop app"

export const SYNC_NOT_LOADED_ERROR = "The sync status is not loaded yet. Ask the user to try again in a moment."

export const MOUNTS_NOT_LOADED_ERROR = "The mount status is not loaded yet. Ask the user to try again in a moment."

export const NO_SYNC_PAIRS_NOTE = "No sync pairs are set up."

export const NO_PAIR_MATCH_NOTE = "No sync pair matches these words, so every pair is listed."

// What a pair's remote directory is called, when nobody has read it yet.
export const REMOTE_NOT_LOADED = "not loaded"

// "2026-11-20 14:03" on the user's clock.
function localMinute(timestamp: number, timeZone: string | undefined): string {
	return new Intl.DateTimeFormat("sv-SE", {
		...(timeZone === undefined ? {} : { timeZone }),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	}).format(timestamp)
}

function nonZero(counts: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0))
}

function pairRow(
	pair: DesktopSyncPair,
	{ handle, remote, timeZone }: { handle: string; remote: string | null; timeZone: string | undefined }
): Record<string, unknown> {
	const issues = nonZero({ ...pair.issues })

	return {
		handle,
		name: pair.name,
		local: pair.localRoot,
		remote: remote ?? REMOTE_NOT_LOADED,
		mode: pair.mode,
		state: pair.phase,
		...(pair.paused ? { paused: true } : {}),
		...(pair.progress === null ? {} : { progress: `${String(pair.progress.done)}/${String(pair.progress.total)}` }),
		...(Object.keys(issues).length === 0 ? {} : { issues }),
		...(pair.lastError === null ? {} : { error: pair.lastError }),
		...(pair.halted === null ? {} : { stopped: pair.halted }),
		...(pair.refused === null ? {} : { refused: pair.refused }),
		...(pair.rootProblem === null ? {} : { rootProblem: pair.rootProblem }),
		...(pair.review === null ? {} : { needsReview: true }),
		...(pair.degraded.local || pair.degraded.remote ? { watching: "periodic passes only" } : {}),
		lastSynced: pair.lastSyncedAt === null ? "never this session" : localMinute(pair.lastSyncedAt, timeZone)
	}
}

// Every pair, or the ones whose name or local directory holds the query's words (all of them when none does).
// `handle` names a pair for open_route; `remoteName` is the remote directory's name as the app holds it, null when it
// has not read it (never fetched for this).
export function syncStatus({
	overview,
	query,
	handle,
	remoteName,
	timeZone
}: {
	overview: DesktopSyncOverview
	query?: string | undefined
	handle: (pair: DesktopSyncPair) => string
	remoteName: (pair: DesktopSyncPair) => string | null
	timeZone?: string | undefined
}): Record<string, unknown> {
	const tokens = query === undefined ? [] : searchTokens(query)
	const matching =
		tokens.length === 0 ? overview.pairs : overview.pairs.filter(pair => matchScore(`${pair.name} ${pair.localRoot}`, tokens) > 0)
	const pairs = matching.length === 0 ? overview.pairs : matching
	const shown = pairs.slice(0, MAX_ARRAY_ITEMS)

	return {
		...(overview.host.state === "running" ? {} : { engine: overview.host.state }),
		pairs: shown.map(pair => pairRow(pair, { handle: handle(pair), remote: remoteName(pair), timeZone })),
		...listRest(pairs.length),
		...(overview.pairs.length === 0
			? { note: NO_SYNC_PAIRS_NOTE }
			: tokens.length > 0 && matching.length === 0
				? { note: NO_PAIR_MATCH_NOTE }
				: {})
	}
}

function mountsError(error: DesktopMountsError | null): Record<string, string> {
	return error === null ? {} : { error: error.message === undefined ? error.code : `${error.code}: ${error.message}` }
}

// The network drive, the servers that are on or failing, and the cache they share.
export function mountsStatus(overview: DesktopMountsOverview): Record<string, unknown> {
	const { drive, cache } = overview
	const where = drive.mountPoint ?? (drive.driveLetter === null ? null : `${drive.driveLetter}:`)

	return {
		...(overview.host.state === "running" ? {} : { engine: overview.host.state }),
		...(overview.available ? {} : { available: false }),
		...(overview.fuse?.state === "missing" ? { driver: "missing" } : {}),
		drive: {
			enabled: drive.enabled,
			state: drive.state,
			...(where === null ? {} : { at: where }),
			...(drive.readOnly ? { readOnly: true } : {}),
			...mountsError(drive.error)
		},
		servers: overview.serves
			.filter(serve => serve.enabled || serve.state !== "off")
			.map(serve => ({
				protocol: serve.protocol,
				state: serve.state,
				...(serve.url === null ? {} : { url: serve.url }),
				...(serve.readOnly ? { readOnly: true } : {}),
				...mountsError(serve.error)
			})),
		cache: {
			used: formatBytes(cache.usedBytes),
			free: formatBytes(cache.freeBytes),
			...nonZero({ pendingUploads: cache.pendingUploads, erroredFiles: cache.erroredFiles })
		}
	}
}
