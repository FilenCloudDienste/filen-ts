import { type } from "arktype"
import type { File as SdkFile, FileVersion, UuidStr } from "@filen/sdk-rs"
import { isUuid } from "@filen/shared"
import {
	emptyWatchState,
	mergeRecordMaps,
	parseWatchState,
	progressMatchesFile,
	withProgress,
	withSubtitleOffset,
	type ItemRec,
	type RegisterRecord,
	type Stamp,
	type WatchStateDoc
} from "@filen/shared/videos"

// The watch-state engine's rules: when progress is journaled locally, when the synced file is uploaded, which old
// versions of it are deleted, and the shapes it keeps in kv and localStorage. Plain and DOM-free.

// ── Storage ──

// One kv row per watch-state record (`videos.v1.r.s:<stableUuid>`, `videos.v1.r.d:<dirUuid>`): registers that may
// still be missing from the synced file. Every tab writes them; the flush that uploaded them deletes them.
export const JOURNAL_KV_PREFIX = "videos.v1.r."
// Account, clock, upload history and backoff of this browser.
export const META_KV_KEY = "videos.v1.meta"
// The synced file as last read or written: its uuid and stable uuid, and the document.
export const HEAD_KV_KEY = "videos.v1.head"
export const DEVICE_KV_KEY = "videos.v1.device"
// Progress not journaled yet when the page went away, written synchronously; merged on the next open.
export const PENDING_STORAGE_KEY = "filen.videos.pendingWatch"

export const FLUSH_LOCK = "filen.videos.watchState.flush"
export const JOURNAL_LOCK = "filen.videos.watchState.journal"
export const CHANNEL_NAME = "filen.videos.watchState"

export const journalRowSchema = type({
	r: "Record<string, unknown>"
})

export const watchMetaSchema = type({
	// Account (drive root uuid) every row belongs to
	a: "string",
	// Hybrid logical clock
	c: "number",
	// Upload times within the last hour, oldest first
	up: "number[]",
	// Current failure backoff and when it ends
	bo: "number",
	bu: "number",
	// [uuid, stableUuid] of each upload by this browser, oldest first
	own: type(["string", "string"]).array(),
	// Generation of the head row, bumped with every write of it (an unchanged one isn't read again)
	hg: "number",
	// Last version cleanup run here, and one done but not yet recorded in the synced file
	gc: "number",
	pg: "number"
})

export type WatchMeta = typeof watchMetaSchema.infer

export function emptyWatchMeta(account: string): WatchMeta {
	return {
		a: account,
		c: 0,
		up: [],
		bo: 0,
		bu: 0,
		own: [],
		hg: 0,
		gc: 0,
		pg: 0
	}
}

export const watchHeadSchema = type({
	a: "string",
	// Head file uuid, its stable uuid, parent and timestamp; absent until the file is known
	"u?": "string",
	"s?": "string",
	"dir?": "string",
	"ts?": "number",
	// The document's JSON
	doc: "string"
})

export type WatchHead = typeof watchHeadSchema.infer

export const deviceSchema = type({
	id: "string"
})

export function journalRowKey(recordKey: string): string {
	return `${JOURNAL_KV_PREFIX}${recordKey}`
}

// The document the journal's records form, validated like a downloaded one; records of an unknown kind are dropped.
export function journalDoc(rows: Iterable<readonly [string, RegisterRecord]>): { doc: WatchStateDoc; maxStamp: number } {
	const raw: WatchStateDoc = emptyWatchState()

	for (const [key, rec] of rows) {
		if (key.startsWith("s:")) {
			raw.items[key] = rec
		} else if (key.startsWith("d:")) {
			raw.series[key] = rec
		}
	}

	const parsed = parseWatchState(raw)

	return parsed.ok
		? {
				doc: parsed.doc,
				maxStamp: parsed.maxStamp
			}
		: {
				doc: emptyWatchState(),
				maxStamp: 0
			}
}

// The records of `from` holding a register `into` lacks: what a merge into `into` would add.
export function contributingRecords({ from, into }: { from: WatchStateDoc; into: WatchStateDoc }): [string, RegisterRecord][] {
	const out: [string, RegisterRecord][] = []

	for (const [map, other] of [
		[from.items, into.items],
		[from.series, into.series]
	] as const) {
		for (const key in map) {
			const rec = map[key]

			if (rec === undefined) {
				continue
			}

			const theirs = other[key]
			const merge = mergeRecordMaps<RegisterRecord>({
				local: {
					[key]: rec
				},
				remote: theirs === undefined ? {} : { [key]: theirs }
			})

			if (merge.localContributed) {
				out.push([key, rec])
			}
		}
	}

	return out
}

// ── Triggers ──

export const JOURNAL_INTERVAL_MS = 15_000
export const JOURNAL_MIN_DELTA_SEC = 10
export const SEMANTIC_DEBOUNCE_MS = 2_000
export const PAUSE_FLUSH_DELTA_SEC = 30
export const PERIODIC_FLUSH_MS = 5 * 60_000
export const PERIODIC_FLUSH_DELTA_SEC = 30
export const UPLOAD_FLOOR_MS = 60_000
export const URGENT_UPLOAD_FLOOR_MS = 10_000
export const MAX_UPLOADS_PER_HOUR = 30
// Uploads within the hourly cap that only semantic changes (completions, marks) may use.
export const SEMANTIC_RESERVED_UPLOADS = 5
export const BACKOFF_MIN_MS = 30_000
export const BACKOFF_MAX_MS = 30 * 60_000
// An upload still out after this is aborted; the state stays dirty.
export const UPLOAD_DEADLINE_MS = 30_000
// What a sign-out waits for its last flush.
export const LOGOUT_FLUSH_MS = 30_000
// Another tab's flush not reported finished after this is taken as abandoned (the tab died mid-upload).
export const PEER_FLUSH_EXPIRY_MS = UPLOAD_DEADLINE_MS + 15_000
// A hidden page uploads only once the position moved this far since the last sync (or a semantic change waits).
export const HIDDEN_FLUSH_DELTA_SEC = 30
// visibilitychange and pagehide both fire when a page closes: one handling for both.
export const HIDDEN_DEDUPE_MS = 500

const HOUR_MS = 3_600_000

// semantic: stop, episode change, completion, a mark, a track or offset change. hidden: the page went away.
export type FlushReason = "semantic" | "hidden" | "pause" | "periodic"

const URGENCY: Record<FlushReason, number> = {
	semantic: 2,
	hidden: 2,
	pause: 1,
	periodic: 0
}

export function moreUrgent(a: FlushReason, b: FlushReason): FlushReason {
	return URGENCY[b] > URGENCY[a] ? b : a
}

// Whether playback progress goes to the journal now: on every state change, else at most every 15 s and only once
// the position moved 10 s.
export function journalDue({
	now,
	pos,
	last,
	stateChanged
}: {
	now: number
	pos: number
	last: { pos: number; at: number } | null
	stateChanged: boolean
}): boolean {
	if (stateChanged || last === null) {
		return true
	}

	return now - last.at >= JOURNAL_INTERVAL_MS && Math.abs(pos - last.pos) >= JOURNAL_MIN_DELTA_SEC
}

// The upload a progress report asks for: a pause 30 s from the synced position, a minute after the last upload; or,
// while playing, every 5 min once the position moved 30 s.
export function playbackFlushReason({
	now,
	pos,
	playing,
	paused,
	synced,
	lastUploadAt
}: {
	now: number
	pos: number
	playing: boolean
	paused: boolean
	synced: { pos: number; at: number }
	lastUploadAt: number
}): FlushReason | null {
	const moved = Math.abs(pos - synced.pos)

	if (paused) {
		return moved >= PAUSE_FLUSH_DELTA_SEC && now - lastUploadAt >= UPLOAD_FLOOR_MS ? "pause" : null
	}

	return playing && now - synced.at >= PERIODIC_FLUSH_MS && moved >= PERIODIC_FLUSH_DELTA_SEC ? "periodic" : null
}

// When the next flush timer fires: the earlier of the two, pushed out by the debounce for a semantic event.
export function mergeFlushTime({
	existing,
	candidate,
	debounce,
	now
}: {
	existing: number | null
	candidate: number
	debounce: boolean
	now: number
}): number {
	const at = existing === null ? candidate : Math.min(existing, candidate)

	return debounce ? Math.max(at, now + SEMANTIC_DEBOUNCE_MS) : at
}

export function recentUploads(times: readonly number[], now: number): number[] {
	return times.filter(at => now - at < HOUR_MS)
}

// The earliest an upload for `reason` may start: 60 s after the last one (10 s for semantic and hidden), past a
// failure's backoff, and never a 31st within an hour; progress alone leaves the last few of those to semantic changes.
export function earliestUploadAt({ reason, now, meta }: { reason: FlushReason; now: number; meta: WatchMeta }): number {
	const floor = URGENCY[reason] === 2 ? URGENT_UPLOAD_FLOOR_MS : UPLOAD_FLOOR_MS
	const last = meta.up.at(-1) ?? -Infinity
	const recent = recentUploads(meta.up, now)
	const cap = reason === "semantic" ? MAX_UPLOADS_PER_HOUR : MAX_UPLOADS_PER_HOUR - SEMANTIC_RESERVED_UPLOADS
	const capped = recent.length >= cap ? (recent[recent.length - cap] ?? now) + HOUR_MS : now

	return Math.max(now, last + floor, meta.bu, capped)
}

export function nextBackoffMs(previous: number): number {
	return previous <= 0 ? BACKOFF_MIN_MS : Math.min(previous * 2, BACKOFF_MAX_MS)
}

// Up to a quarter more than the backoff, from `random` in [0, 1).
export const BACKOFF_JITTER = 0.25

export function jitteredBackoffMs(backoffMs: number, random: number): number {
	const unit = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0

	return Math.round(backoffMs * (1 + BACKOFF_JITTER * unit))
}

// ── Version cleanup ──

// Own uploads remembered for cleanup; older ones are left to the periodic cleanup.
export const OWN_UPLOADS_MAX = 64
export const GC_INTERVAL_MS = 7 * 86_400_000
export const GC_MIN_AGE_MS = 7 * 86_400_000
export const GC_KEEP_NEWEST = 2
export const DELETE_BATCH = 20

export type OwnUpload = [uuid: string, stableUuid: string]

export function withOwnUpload(own: readonly OwnUpload[], upload: OwnUpload): OwnUpload[] {
	return [...own.filter(([uuid]) => uuid !== upload[0]), upload].slice(-OWN_UPLOADS_MAX)
}

// This browser's superseded uploads of the head's own lineage to delete: every one but the newest superseded (kept
// as a safety copy), never the head nor the last upload. Another lineage (the file renamed, moved or trashed and a
// new one started) is never touched: a version delete there could take that file's live head.
export function pruneTargets({ own, head }: { own: readonly OwnUpload[]; head: { uuid: string; stableUuid: string } }): string[] {
	const last = own.at(-1)?.[0]

	return own
		.filter(([uuid, stableUuid]) => stableUuid === head.stableUuid && uuid !== head.uuid)
		.map(([uuid]) => uuid)
		.slice(0, -1)
		.filter(uuid => uuid !== last)
}

// Archived versions older than a week, beyond the newest two archived ones; never the head nor a protected uuid.
export function gcTargets({
	versions,
	headUuid,
	protect,
	now
}: {
	versions: readonly FileVersion[]
	headUuid: string
	protect: ReadonlySet<string>
	now: number
}): FileVersion[] {
	return versions
		.filter(version => version.uuid !== headUuid)
		.sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1))
		.slice(GC_KEEP_NEWEST)
		.filter(version => now - Number(version.timestamp) > GC_MIN_AGE_MS && !protect.has(version.uuid))
}

function isUuidStr(value: string): value is UuidStr {
	return isUuid(value)
}

// The version of `head`'s lineage with uuid `uuid`, as a delete takes it (the delete sends only the uuid).
export function versionOf(head: SdkFile, uuid: string): FileVersion | null {
	if (!isUuidStr(uuid) || head.stableUUID === undefined) {
		return null
	}

	return {
		bucket: head.bucket,
		region: head.region,
		chunks: head.chunks,
		size: head.size,
		metadata: head.meta,
		timestamp: head.timestamp,
		uuid,
		stableUUID: head.stableUUID
	}
}

// A download that found nothing: the file (or version) was deleted since it was seen.
export function isGoneError(e: unknown): boolean {
	return typeof e === "object" && e !== null && "kind" in e && (e.kind === "FileNotFound" || e.kind === "FileChunkNotFound")
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false
		}
	}

	return true
}

export function batches<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []

	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size))
	}

	return out
}

// ── Pending progress ──

// [stableUuid, fileUuid, size, pos, dur, lp, t, d, part]: uuids, ids and numbers only.
export type PendingEntry = [string, string, number, number, number, number, number, string, number]

export interface PendingWatch {
	a: string
	e: PendingEntry[]
}

export const PENDING_MAX_BYTES = 4096

// Sign-out: the pending progress lives in localStorage, which the kv wipe doesn't reach. Storage blocked means
// nothing was written there either.
export function wipePendingWatch(storage: () => Storage | null): void {
	try {
		storage()?.removeItem(PENDING_STORAGE_KEY)
	} catch {
		// Nothing to remove
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function isShortString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128
}

function isPendingEntry(value: unknown): value is PendingEntry {
	return (
		Array.isArray(value) &&
		value.length === 9 &&
		isShortString(value[0]) &&
		isShortString(value[1]) &&
		isFiniteNumber(value[2]) &&
		isFiniteNumber(value[3]) &&
		isFiniteNumber(value[4]) &&
		isFiniteNumber(value[5]) &&
		isFiniteNumber(value[6]) &&
		isShortString(value[7]) &&
		isFiniteNumber(value[8])
	)
}

export function decodePending(text: string | null): PendingWatch | null {
	if (text === null) {
		return null
	}

	let value: unknown

	try {
		value = JSON.parse(text)
	} catch {
		return null
	}

	if (typeof value !== "object" || value === null || !("a" in value) || !("e" in value)) {
		return null
	}

	const { a, e } = value

	if (!isShortString(a) || !Array.isArray(e)) {
		return null
	}

	return {
		a,
		e: e.filter(isPendingEntry)
	}
}

// `entries` folded into what another tab of the account left (the newer stamp per file wins), newest first, cut to
// fit PENDING_MAX_BYTES. Another account's leftovers are replaced.
export function encodePending({
	previous,
	account,
	entries
}: {
	previous: PendingWatch | null
	account: string
	entries: readonly PendingEntry[]
}): string {
	const byFile = new Map<string, PendingEntry>()

	for (const entry of [...(previous?.a === account ? previous.e : []), ...entries]) {
		const known = byFile.get(entry[0])

		if (known === undefined || entry[6] > known[6]) {
			byFile.set(entry[0], entry)
		}
	}

	const kept = [...byFile.values()].sort((a, b) => b[6] - a[6])

	for (;;) {
		const text = JSON.stringify({
			a: account,
			e: kept
		} satisfies PendingWatch)

		if (text.length <= PENDING_MAX_BYTES || kept.length === 0) {
			return text
		}

		kept.pop()
	}
}

// ── Edited videos ──

// An edited video saved as a new version of the same file (same stable uuid): the resume point moves to where that
// moment lands in the edit (`map`; null when it was cut, so playback starts over) and is fingerprinted with the new
// version; a subtitle offset, timed against the old cut, is cleared. A stack's later part keeps its record (its
// position is another part's), as does a record about another version. Null when nothing changes.
export function rebasedEditRecord({
	rec,
	stamp,
	previous,
	uuid,
	size,
	duration,
	map
}: {
	rec: ItemRec | undefined
	stamp: Stamp
	previous: { uuid: string; size: number }
	uuid: string
	size: number
	duration: number
	map: (seconds: number) => number | null
}): ItemRec | null {
	if (rec === undefined) {
		return null
	}

	const progress = rec.p
	const rebase =
		progress !== undefined &&
		(progress.part ?? 0) === 0 &&
		progressMatchesFile({ progress, file: { uuid: previous.uuid, size: previous.size } })
	let next: ItemRec = rec

	if (rebase) {
		next = withProgress({ rec: next, stamp, pos: map(progress.pos) ?? 0, dur: duration, lp: progress.lp, uuid, size })
	}

	if (rec.o !== undefined && rec.o.subMs !== 0) {
		next = withSubtitleOffset({ rec: next, stamp, subMs: 0 })
	}

	return next === rec ? null : next
}
