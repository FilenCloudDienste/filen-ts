// Synced watch state: one JSON document of last-writer-wins registers, each stamped by a hybrid logical clock and a
// writer id. Replicas merge register by register, so every merge order converges on the same document. Deletions are
// tombstones, so compaction survives merges with older copies. Positions are stored raw; played and resumable are
// derived on read with the thresholds common media servers use.
//
// Flush contract: doc = compact(merge(local, remote)), uploaded when it differs from the remote head (see
// reconcileWatchState).

import {
	MAX_ID_LENGTH,
	UNSAFE_KEY,
	checkedStamp,
	compareStamps,
	hasValidStamp,
	hlcPhysicalMs,
	isCount,
	isId,
	isNonNegative,
	isRecord,
	isStamped,
	mergeFields,
	mergeMaps,
	nonNegative,
	normalizeRecord,
	tombstoneAt,
	type Hlc,
	type MergeFlags,
	type RegisterRecord,
	type Stamp,
	type Tombstone
} from "./registerRecords"

// The register machinery, still reached through this module by the Videos code built on it.
export {
	HLC_SPAN,
	MAX_CLOCK_SKEW_MS,
	compareStamps,
	hasLiveRegister,
	hlcObserve,
	hlcPhysicalMs,
	hlcTick,
	mergeRecordMaps,
	mergeUnknownFields,
	parseRegisterRecord,
	setRegister,
	tombstoneRecord,
	type Hlc,
	type RegisterDocMerge,
	type RegisterRecord,
	type Stamp,
	type Tombstone
} from "./registerRecords"

const DAY_MS = 86_400_000

// The document's file in the Videos system directory.
export const WATCH_STATE_FILE_NAME = "watch-state.v1.json"

// ── Schema ───────────────────────────────────────────────────────────────────

// Raw progress in seconds (dur 0 = unknown); lp = wall-clock ms of the last play; u/sz = uuid and size of the file
// it was recorded against; part = stack part index.
export interface ProgressRegister extends Stamp {
	pos: number
	dur: number
	lp: number
	u: string
	sz: number
	part?: number
	[key: string]: unknown
}

// pl = played; pc = completed plays.
export interface WatchedRegister extends Stamp {
	pl: boolean
	pc: number
	[key: string]: unknown
}

// Subtitle offset for this file.
export interface OffsetRegister extends Stamp {
	subMs: number
	[key: string]: unknown
}

// Removed from Continue Watching; a later play clears it.
export interface HiddenRegister extends Stamp {
	v: boolean
	[key: string]: unknown
}

export interface ItemRec {
	p?: ProgressRegister
	w?: WatchedRegister
	o?: OffsetRegister
	h?: HiddenRegister
	x?: Tombstone
	[key: string]: unknown
}

export interface AudioLanguageRegister extends Stamp {
	v: string
	[key: string]: unknown
}

// v null = subtitles off.
export interface SubtitleLanguageRegister extends Stamp {
	v: string | null
	[key: string]: unknown
}

// Per-series audio (al) and subtitle (sl) language, each its own register.
export interface SeriesPrefs {
	al?: AudioLanguageRegister
	sl?: SubtitleLanguageRegister
	x?: Tombstone
	[key: string]: unknown
}

// items keyed by itemKey(stableUuid), series by seriesKey(dirUuid); gc = time of the last version cleanup.
export interface WatchStateDoc {
	v: 1
	gc?: number
	items: Record<string, ItemRec>
	series: Record<string, SeriesPrefs>
	[key: string]: unknown
}

type WatchRecord = RegisterRecord

export function itemKey(stableUuid: string): string {
	return `s:${stableUuid}`
}

export function seriesKey(dirUuid: string): string {
	return `d:${dirUuid}`
}

export function emptyWatchState(): WatchStateDoc {
	return {
		v: 1,
		items: {},
		series: {}
	}
}

// ── Validation ───────────────────────────────────────────────────────────────

function isKey(key: string, prefix: string): boolean {
	return key.length > 2 && key.length <= MAX_ID_LENGTH + 2 && key.startsWith(prefix)
}

type RecordKind = "item" | "series"

// true/false for a known register, null for a field this version does not know.
function checkField(kind: RecordKind, key: string, value: unknown): boolean | null {
	if (key === "x") {
		return hasValidStamp(value) && isNonNegative(value["e"])
	}

	if (kind === "series") {
		switch (key) {
			case "al": {
				return hasValidStamp(value) && isId(value["v"])
			}

			case "sl": {
				return hasValidStamp(value) && (value["v"] === null || isId(value["v"]))
			}

			default: {
				return null
			}
		}
	}

	switch (key) {
		case "p": {
			return (
				hasValidStamp(value) &&
				isNonNegative(value["pos"]) &&
				isNonNegative(value["dur"]) &&
				isNonNegative(value["lp"]) &&
				isId(value["u"]) &&
				isCount(value["sz"]) &&
				(value["part"] === undefined || isCount(value["part"]))
			)
		}

		case "w": {
			return hasValidStamp(value) && typeof value["pl"] === "boolean" && isCount(value["pc"])
		}

		case "o": {
			const subMs = isRecord(value) ? value["subMs"] : undefined

			return hasValidStamp(value) && typeof subMs === "number" && Number.isFinite(subMs)
		}

		case "h": {
			return hasValidStamp(value) && typeof value["v"] === "boolean"
		}

		default: {
			return null
		}
	}
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export type WatchStateParse =
	| {
			ok: true
			doc: WatchStateDoc
			// Registers, records and fields rejected individually
			dropped: number
			// Highest stamp, for hlcObserve
			maxStamp: Hlc
	  }
	| {
			ok: false
			reason: "malformed" | "unsupportedVersion"
	  }

interface ParseContext {
	dropped: number
	maxStamp: Hlc
}

// The record itself when every known register is valid (the common case), otherwise a copy without the bad ones.
function parseRecord(raw: unknown, kind: RecordKind, context: ParseContext): WatchRecord | null {
	if (!isRecord(raw)) {
		context.dropped++

		return null
	}

	let clean = true
	let fields = 0

	for (const key in raw) {
		if (key === UNSAFE_KEY) {
			clean = false

			continue
		}

		const value = raw[key]
		const valid = checkField(kind, key, value)

		if (valid === false) {
			clean = false
			context.dropped++

			continue
		}

		if (valid && isStamped(value)) {
			context.maxStamp = Math.max(context.maxStamp, value.t)
		}

		fields++
	}

	if (fields === 0) {
		return null
	}

	if (clean) {
		return normalizeRecord(raw)
	}

	const out: WatchRecord = {}

	for (const key in raw) {
		if (key !== UNSAFE_KEY && checkField(kind, key, raw[key]) !== false) {
			out[key] = raw[key]
		}
	}

	return normalizeRecord(out)
}

// Validates untrusted JSON register by register: a bad register, record or key is dropped on its own, never the
// document. A document from a newer schema version is reported, not parsed, so it is never overwritten as v1.
// Registers stamped ahead of any clock are kept, so every replica reads the same document.
export function parseWatchState(value: unknown): WatchStateParse {
	if (!isRecord(value)) {
		return {
			ok: false,
			reason: "malformed"
		}
	}

	const version = value["v"]

	if (version !== 1) {
		return {
			ok: false,
			reason: typeof version === "number" && version > 1 ? "unsupportedVersion" : "malformed"
		}
	}

	const rawItems = value["items"] ?? {}
	const rawSeries = value["series"] ?? {}

	if (!isRecord(rawItems) || !isRecord(rawSeries)) {
		return {
			ok: false,
			reason: "malformed"
		}
	}

	const context: ParseContext = {
		dropped: 0,
		maxStamp: 0
	}

	const items: Record<string, ItemRec> = {}

	for (const key in rawItems) {
		if (!isKey(key, "s:")) {
			context.dropped++

			continue
		}

		const rec = parseRecord(rawItems[key], "item", context)

		if (rec !== null) {
			items[key] = rec
		}
	}

	const series: Record<string, SeriesPrefs> = {}

	for (const key in rawSeries) {
		if (!isKey(key, "d:")) {
			context.dropped++

			continue
		}

		const prefs = parseRecord(rawSeries[key], "series", context)

		if (prefs !== null) {
			series[key] = prefs
		}
	}

	const doc: WatchStateDoc = {
		v: 1,
		items,
		series
	}

	for (const key in value) {
		if (key === "v" || key === "items" || key === "series" || key === UNSAFE_KEY) {
			continue
		}

		const field = value[key]

		if (key === "gc") {
			if (isNonNegative(field)) {
				doc.gc = field
			} else {
				context.dropped++
			}

			continue
		}

		doc[key] = field
	}

	return {
		ok: true,
		doc,
		dropped: context.dropped,
		maxStamp: context.maxStamp
	}
}

export function parseWatchStateText(text: string): WatchStateParse {
	let value: unknown

	try {
		value = JSON.parse(text)
	} catch {
		return {
			ok: false,
			reason: "malformed"
		}
	}

	return parseWatchState(value)
}

// ── Merge ────────────────────────────────────────────────────────────────────

const WATCH_STATE_FIELDS: ReadonlySet<string> = new Set(["v", "gc", "items", "series"])

export interface WatchStateMerge {
	doc: WatchStateDoc
	// local holds something remote lacks
	localContributed: boolean
	// remote holds something local lacks
	remoteContributed: boolean
}

// Per-register last-writer-wins on (t, d) with tombstones applied: associative, commutative and idempotent. Returns
// `local` itself when remote adds nothing and `remote` itself when local adds nothing.
export function mergeWatchState({ local, remote }: { local: WatchStateDoc; remote: WatchStateDoc }): WatchStateMerge {
	const flags: MergeFlags = {
		a: false,
		b: false
	}

	const doc: WatchStateDoc = {
		v: 1,
		items: mergeMaps(local.items, remote.items, flags),
		series: mergeMaps(local.series, remote.series, flags)
	}

	if (local.gc !== undefined || remote.gc !== undefined) {
		const gc = Math.max(local.gc ?? 0, remote.gc ?? 0)

		doc.gc = gc
		flags.a ||= local.gc === gc && remote.gc !== gc
		flags.b ||= remote.gc === gc && local.gc !== gc
	}

	mergeFields(local, remote, WATCH_STATE_FIELDS, doc, flags)

	return {
		doc: !flags.b ? local : !flags.a ? remote : doc,
		localContributed: flags.a,
		remoteContributed: flags.b
	}
}

// ── Derived state ────────────────────────────────────────────────────────────

export const MIN_RESUME_PCT = 5
export const MAX_RESUME_PCT = 90
export const MIN_RESUME_DURATION_SEC = 300
export const END_TOLERANCE_SEC = 1
// A replaced file of the same size keeps its resume point while durations agree within this.
export const DURATION_MATCH_TOLERANCE_SEC = 2

// Short movies and episodes count as played once started past MIN_RESUME_PCT; other videos and extras do not.
export type WatchItemClass = "movie" | "episode" | "other" | "extra"

// Whether a playback position counts as a completed play. `ended` = playback reached the natural end, which is the
// only signal when the duration is unknown.
export function isCompletePosition({
	pos,
	dur,
	itemClass,
	ended = false
}: {
	pos: number
	dur: number
	itemClass: WatchItemClass
	ended?: boolean
}): boolean {
	if (ended) {
		return true
	}

	if (!(dur > 0)) {
		return false
	}

	const pct = (pos / dur) * 100

	if (pct > MAX_RESUME_PCT || pos >= dur - END_TOLERANCE_SEC) {
		return true
	}

	return dur < MIN_RESUME_DURATION_SEC && pct >= MIN_RESUME_PCT && (itemClass === "movie" || itemClass === "episode")
}

// True when moving from `from` to `to` turns playback into a completed play; the caller records it once per session.
export function crossesCompletion({
	from,
	to,
	dur,
	itemClass
}: {
	from: number
	to: number
	dur: number
	itemClass: WatchItemClass
}): boolean {
	return (
		!isCompletePosition({
			pos: from,
			dur,
			itemClass
		}) &&
		isCompletePosition({
			pos: to,
			dur,
			itemClass
		})
	)
}

export function isResumablePosition({ pos, dur }: { pos: number; dur: number }): boolean {
	if (!(dur >= MIN_RESUME_DURATION_SEC)) {
		return false
	}

	const pct = (pos / dur) * 100

	return pct >= MIN_RESUME_PCT && pct <= MAX_RESUME_PCT && pos < dur - END_TOLERANCE_SEC
}

// The file currently behind a stable uuid; durationSec once probed.
export interface WatchedFile {
	uuid: string
	size: number
	durationSec?: number | null | undefined
}

// Progress recorded against another file of the same lineage stays valid only while size and duration agree.
export function progressMatchesFile({ progress, file }: { progress: ProgressRegister; file: WatchedFile }): boolean {
	if (progress.u === file.uuid) {
		return true
	}

	if (progress.sz !== file.size) {
		return false
	}

	const probed = file.durationSec

	return probed === null || probed === undefined || progress.dur === 0 || Math.abs(progress.dur - probed) <= DURATION_MATCH_TOLERANCE_SEC
}

export interface DerivedWatchState {
	played: boolean
	playCount: number
	// A valid resume point exists (the detail page offers Resume)
	inProgress: boolean
	// Removed from Continue Watching until the next play
	hidden: boolean
	// inProgress and not hidden: shown in Continue Watching with a progress bar
	resumable: boolean
	// Resume position, 0 unless inProgress
	positionSec: number
	// Probed duration, else the recorded one, else 0
	durationSec: number
	// Wall-clock ms of the last play or mark-watched, 0 if never
	lastPlayedMs: number
}

// `lastPlayedCeilingMs` caps display times written by devices whose clock runs ahead.
export function deriveWatchState({
	rec,
	file,
	lastPlayedCeilingMs
}: {
	rec: ItemRec | undefined
	file: WatchedFile
	lastPlayedCeilingMs?: number | undefined
}): DerivedWatchState {
	const p = rec?.p
	const w = rec?.w
	const h = rec?.h
	const played = w?.pl === true
	const probed = file.durationSec
	const durationSec = probed !== null && probed !== undefined && probed > 0 ? probed : (p?.dur ?? 0)
	const inProgress =
		p !== undefined &&
		(w === undefined || compareStamps(p, w) > 0) &&
		isResumablePosition({
			pos: p.pos,
			dur: durationSec
		}) &&
		progressMatchesFile({
			progress: p,
			file
		})
	const hidden = p !== undefined && h !== undefined && h.v && compareStamps(h, p) > 0

	let lastPlayedMs = Math.max(p?.lp ?? 0, played && w !== undefined ? hlcPhysicalMs(w.t) : 0)

	if (lastPlayedCeilingMs !== undefined && lastPlayedMs > lastPlayedCeilingMs) {
		lastPlayedMs = lastPlayedCeilingMs
	}

	return {
		played,
		playCount: w?.pc ?? 0,
		inProgress,
		hidden,
		resumable: inProgress && !hidden,
		positionSec: inProgress ? p.pos : 0,
		durationSec,
		lastPlayedMs
	}
}

// ── Register writes ──────────────────────────────────────────────────────────
// Every write yields exactly what the parser accepts: out-of-range numbers are coerced (unknown or non-finite
// durations become 0), and an invalid stamp or file uuid is a caller bug and throws.

// Non-negative seconds at millisecond precision, 0 when not finite.
function seconds(value: number): number {
	const rounded = Math.round(value * 1000) / 1000

	return Number.isFinite(rounded) && rounded > 0 ? rounded : 0
}

export function withProgress({
	rec,
	stamp,
	pos,
	dur,
	lp,
	uuid,
	size,
	part
}: {
	rec: ItemRec | undefined
	stamp: Stamp
	pos: number
	dur: number
	lp: number
	uuid: string
	size: number
	part?: number | undefined
}): ItemRec {
	if (!isId(uuid)) {
		throw new RangeError("Invalid file uuid")
	}

	const p: ProgressRegister = {
		...checkedStamp(stamp),
		pos: seconds(pos),
		dur: seconds(dur),
		lp: nonNegative(lp),
		u: uuid,
		sz: isCount(size) ? size + 0 : 0
	}

	if (isCount(part)) {
		p.part = part + 0
	}

	return normalizeRecord({
		...rec,
		p
	})
}

// A completed play: played, one more completion.
export function withCompletion({ rec, stamp }: { rec: ItemRec | undefined; stamp: Stamp }): ItemRec {
	return normalizeRecord({
		...rec,
		w: {
			...checkedStamp(stamp),
			pl: true,
			pc: Math.min((rec?.w?.pc ?? 0) + 1, Number.MAX_SAFE_INTEGER)
		}
	})
}

// Manual mark: played without counting a completion. The newer stamp also ends any resume point.
export function markWatched({ rec, stamp }: { rec: ItemRec | undefined; stamp: Stamp }): ItemRec {
	return normalizeRecord({
		...rec,
		w: {
			...checkedStamp(stamp),
			pl: true,
			pc: rec?.w?.pc ?? 0
		}
	})
}

// Unplayed with the play count and position reset, as media servers do.
export function markUnwatched({ rec, stamp }: { rec: ItemRec | undefined; stamp: Stamp }): ItemRec {
	const checked = checkedStamp(stamp)
	const out: ItemRec = {
		...rec,
		w: {
			...checked,
			pl: false,
			pc: 0
		}
	}

	if (rec?.p !== undefined) {
		out.p = {
			...rec.p,
			...checked,
			pos: 0
		}
	}

	return normalizeRecord(out)
}

export function hideFromContinueWatching({ rec, stamp }: { rec: ItemRec | undefined; stamp: Stamp }): ItemRec {
	return normalizeRecord({
		...rec,
		h: {
			...checkedStamp(stamp),
			v: true
		}
	})
}

// Whole milliseconds; a non-finite offset becomes 0.
export function withSubtitleOffset({ rec, stamp, subMs }: { rec: ItemRec | undefined; stamp: Stamp; subMs: number }): ItemRec {
	const rounded = Math.round(subMs)

	return normalizeRecord({
		...rec,
		o: {
			...checkedStamp(stamp),
			subMs: Number.isFinite(rounded) ? rounded || 0 : 0
		}
	})
}

// An empty or overlong language code is not a language; the preferences are returned unchanged.
export function withAudioLanguage({
	prefs,
	stamp,
	language
}: {
	prefs: SeriesPrefs | undefined
	stamp: Stamp
	language: string
}): SeriesPrefs {
	const checked = checkedStamp(stamp)

	if (!isId(language)) {
		return prefs ?? {}
	}

	return normalizeRecord({
		...prefs,
		al: {
			...checked,
			v: language
		}
	})
}

// language null = subtitles off.
export function withSubtitleLanguage({
	prefs,
	stamp,
	language
}: {
	prefs: SeriesPrefs | undefined
	stamp: Stamp
	language: string | null
}): SeriesPrefs {
	const checked = checkedStamp(stamp)

	if (language !== null && !isId(language)) {
		return prefs ?? {}
	}

	return normalizeRecord({
		...prefs,
		sl: {
			...checked,
			v: language
		}
	})
}

function newestStamp(rec: WatchRecord): Stamp | null {
	let newest: Stamp | null = null

	for (const key in rec) {
		const value = rec[key]

		if (key !== "x" && isStamped(value) && (newest === null || compareStamps(value, newest) > 0)) {
			newest = value
		}
	}

	return newest
}

// Deletes a record (an item or series) as of everything currently in it; writes stamped later survive. `at` is the
// deciding device's wall clock (expiry basis). Use it to prune records no library holds any more.
export function deleteRecord<T extends ItemRec | SeriesPrefs>({ rec, at }: { rec: T; at: number }): T {
	const newest = newestStamp(rec)

	return newest === null ? rec : tombstoneAt(rec, newest, at)
}

// ── Compaction ───────────────────────────────────────────────────────────────

// Compaction target; the hard limit is what one document may ever be (one upload/download chunk).
export const WATCH_STATE_SOFT_LIMIT_BYTES = 256 * 1024
export const WATCH_STATE_HARD_LIMIT_BYTES = 1024 * 1024
export const STALE_PROGRESS_MS = 365 * DAY_MS
// Long enough for an offline replica to come back and have its older copies of deleted registers pruned.
export const TOMBSTONE_TTL_MS = 90 * DAY_MS

export function utf8Length(text: string): number {
	let bytes = text.length

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code >= 0x80) {
			// Two UTF-16 units of a surrogate pair add 2 each: 4 bytes in total
			bytes += code < 0x800 ? 1 : code >= 0xd800 && code <= 0xdfff ? 1 : 2
		}
	}

	return bytes
}

// "key":value without its separating comma: exact for a replacement, never more than the saving for a removal.
function entryBytes(key: string, value: unknown): number {
	return utf8Length(JSON.stringify(key)) + 1 + utf8Length(JSON.stringify(value))
}

function activityMs(rec: WatchRecord): number {
	let at = 0

	for (const key in rec) {
		const value = rec[key]

		if (key !== "x" && isStamped(value)) {
			at = Math.max(at, hlcPhysicalMs(value.t))
		}
	}

	const lp = rec["p"]

	return isRecord(lp) && typeof lp["lp"] === "number" ? Math.max(at, lp["lp"]) : at
}

function isTombstoneOnly(rec: WatchRecord): rec is WatchRecord & { x: Tombstone } {
	return rec.x !== undefined && newestStamp(rec) === null
}

// Writer ids are "<device>.<tab>": every tab of a device shares its clock.
function writerDevice(d: string): string {
	const dot = d.indexOf(".")

	return dot < 0 ? d : d.slice(0, dot)
}

interface WallTime {
	at: number
	// Device of a progress lp; null for a tombstone e (an earlier reference, or a deleting device's clock)
	device: string | null
}

// The document's own clock, so every replica compacts the same merged document identically. It reads wall-clock
// times (progress lp, tombstone e): stamps follow any stamp they observe up to MAX_CLOCK_SKEW_MS ahead, so one fast
// clock would carry every replica's stamps forward; stamps count only in a document with no wall-clock time.
// Times split into runs wherever two neighbours lie more than TOMBSTONE_TTL_MS apart, and the newest run counts when
// it holds two times or more and either has two devices, continues a device of an older run, or no older run has a
// device: a clock running far ahead from a device no older time names, alone or from its many plays, never expires
// tombstones. A new device after a longer pause is held back the same way until the older devices' times are gone.
// A known device whose clock jumps ahead reads the same as its return after a pause longer than the TTL, so its
// far-ahead times do count; only a clamp to each caller's own clock could tell them apart, and that would stop
// replicas compacting the same document alike.
function referenceMs(doc: WatchStateDoc): number {
	const wall: WallTime[] = []
	let stamped = 0

	for (const map of [doc.items, doc.series] as Record<string, WatchRecord>[]) {
		for (const key in map) {
			const rec = map[key]

			if (rec === undefined) {
				continue
			}

			for (const field in rec) {
				const value = rec[field]

				if (isStamped(value)) {
					stamped = Math.max(stamped, hlcPhysicalMs(value.t))
				}
			}

			const p = rec["p"]

			if (isRecord(p) && typeof p["lp"] === "number" && p["lp"] > 0) {
				wall.push({
					at: p["lp"],
					device: typeof p["d"] === "string" ? writerDevice(p["d"]) : null
				})
			}

			if (rec.x !== undefined && rec.x.e > 0) {
				wall.push({
					at: rec.x.e,
					device: null
				})
			}
		}
	}

	if (wall.length === 0) {
		return stamped
	}

	wall.sort((a, b) => b.at - a.at)

	// Newest first: run index of every time, and the oldest run each device appears in.
	const runOf = new Int32Array(wall.length)
	const oldestRun = new Map<string, number>()
	let lastDeviceRun = -1
	let run = 0

	for (let i = 0; i < wall.length; i++) {
		const time = wall[i] as WallTime

		if (i > 0 && (wall[i - 1] as WallTime).at - time.at > TOMBSTONE_TTL_MS) {
			run++
		}

		runOf[i] = run

		if (time.device !== null) {
			oldestRun.set(time.device, run)
			lastDeviceRun = run
		}
	}

	for (let start = 0; start < wall.length;) {
		const current = runOf[start] as number
		let end = start
		let first: string | null = null
		let trusted = current >= lastDeviceRun

		for (; end < wall.length && runOf[end] === current; end++) {
			const device = (wall[end] as WallTime).device

			if (device === null || trusted) {
				continue
			}

			if ((oldestRun.get(device) as number) > current || (first !== null && first !== device)) {
				trusted = true
			}

			first ??= device
		}

		if (trusted && end - start >= 2) {
			return (wall[start] as WallTime).at
		}

		start = end
	}

	return (wall[wall.length - 1] as WallTime).at
}

export interface WatchStateCompaction {
	doc: WatchStateDoc
	// Serialized UTF-8 size of `doc`
	bytes: number
	// Records tombstoned or dropped
	removed: number
}

interface Candidate {
	key: string
	at: number
}

// Deterministic in `doc` alone. Always expires tombstone-only records past TOMBSTONE_TTL_MS; past `limitBytes`,
// tombstones oldest first and only as far as needed: progress older than STALE_PROGRESS_MS on unplayed items, progress
// superseded by a completion (each only where no other register would go with it), then whole items and series preferences (toward `limitBytes` when tombstoning can get
// there, else only below `hardLimitBytes`). Past `hardLimitBytes` it finally drops the oldest tombstone-only records.
// Unknown top-level fields are never touched. Returns `doc` itself when nothing changes.
export function compactWatchState({
	doc,
	limitBytes = WATCH_STATE_SOFT_LIMIT_BYTES,
	hardLimitBytes = WATCH_STATE_HARD_LIMIT_BYTES
}: {
	doc: WatchStateDoc
	limitBytes?: number
	hardLimitBytes?: number
}): WatchStateCompaction {
	const initial = utf8Length(JSON.stringify(doc))
	const now = referenceMs(doc)
	const items: Record<string, WatchRecord> = {
		...doc.items
	}

	const series: Record<string, WatchRecord> = {
		...doc.series
	}

	let bytes = initial
	let removed = 0

	const drop = (map: Record<string, WatchRecord>, key: string, rec: WatchRecord): void => {
		bytes -= entryBytes(key, rec)
		delete map[key]
		removed++
	}

	for (const map of [items, series]) {
		for (const key in map) {
			const rec = map[key]

			if (rec !== undefined && isTombstoneOnly(rec) && now - rec.x.e > TOMBSTONE_TTL_MS) {
				drop(map, key, rec)
			}
		}
	}

	// Collects candidates, then applies them oldest first while over `limit`, keeping only changes that shrink.
	const pass = (
		map: Record<string, WatchRecord>,
		limit: number,
		select: (rec: WatchRecord) => number | null,
		apply: (rec: WatchRecord) => WatchRecord | null
	): void => {
		if (bytes <= limit) {
			return
		}

		const candidates: Candidate[] = []

		for (const key in map) {
			const rec = map[key]
			const at = rec === undefined ? null : select(rec)

			if (at !== null) {
				candidates.push({
					key,
					at
				})
			}
		}

		candidates.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))

		for (const { key } of candidates) {
			if (bytes <= limit) {
				return
			}

			const rec = map[key]

			if (rec === undefined) {
				continue
			}

			const next = apply(rec)

			if (next === null) {
				drop(map, key, rec)

				continue
			}

			const before = entryBytes(key, rec)
			const after = entryBytes(key, next)

			if (after < before) {
				map[key] = next
				bytes -= before - after
				removed++
			}
		}
	}

	const progressOf = (rec: WatchRecord): ProgressRegister | undefined => (rec as ItemRec).p
	const watchedOf = (rec: WatchRecord): WatchedRegister | undefined => (rec as ItemRec).w
	const staleBefore = now - STALE_PROGRESS_MS
	// A tombstone at the progress stamp deletes every register stamped at or before it, so a progress-only deletion
	// is offered only where nothing else of value goes with it: an older hide (it only ever applies over a newer
	// progress) and an unplayed, uncounted watched register are inert; an older offset or an unknown register is not.
	const progressOnlyCovered = (rec: WatchRecord, p: ProgressRegister): boolean => {
		for (const key in rec) {
			if (key === "x" || key === "p") {
				continue
			}

			const value = rec[key]

			if (isStamped(value) && compareStamps(value, p) > 0) {
				continue
			}

			if (key === "h" || (key === "w" && isRecord(value) && value["pl"] === false && value["pc"] === 0)) {
				continue
			}

			return false
		}

		return true
	}

	const tombstoneProgress = (rec: WatchRecord): WatchRecord => {
		const p = progressOf(rec)

		return p === undefined ? rec : tombstoneAt(rec, p, now)
	}

	const tombstoneAll = (rec: WatchRecord): WatchRecord => {
		const newest = newestStamp(rec)

		return newest === null ? rec : tombstoneAt(rec, newest, now)
	}

	pass(
		items,
		limitBytes,
		rec => {
			const p = progressOf(rec)

			return p !== undefined && watchedOf(rec)?.pl !== true && p.lp < staleBefore && progressOnlyCovered(rec, p) ? p.lp : null
		},
		tombstoneProgress
	)
	pass(
		items,
		limitBytes,
		rec => {
			const p = progressOf(rec)
			const w = watchedOf(rec)

			return p !== undefined && w !== undefined && w.pl && compareStamps(w, p) > 0 && progressOnlyCovered(rec, p) ? p.lp : null
		},
		tombstoneProgress
	)
	// Tombstones outlive what they delete, so whole-record deletion only chases the soft target when it can reach it;
	// otherwise it deletes just enough to respect the hard limit instead of wiping every record.
	let reachable = bytes

	if (bytes > limitBytes) {
		for (const map of [items, series]) {
			for (const key in map) {
				const rec = map[key]

				if (rec !== undefined && newestStamp(rec) !== null) {
					reachable -= Math.max(0, entryBytes(key, rec) - entryBytes(key, tombstoneAll(rec)))
				}
			}
		}
	}

	const recordLimit = reachable <= limitBytes ? limitBytes : hardLimitBytes

	pass(items, recordLimit, rec => (newestStamp(rec) === null ? null : activityMs(rec)), tombstoneAll)
	pass(series, recordLimit, rec => (newestStamp(rec) === null ? null : activityMs(rec)), tombstoneAll)

	for (const map of [items, series]) {
		pass(
			map,
			hardLimitBytes,
			rec => (isTombstoneOnly(rec) ? rec.x.e : null),
			() => null
		)
	}

	if (removed === 0) {
		return {
			doc,
			bytes: initial,
			removed
		}
	}

	const compacted: WatchStateDoc = {
		...doc,
		items: items as Record<string, ItemRec>,
		series: series as Record<string, SeriesPrefs>
	}

	return {
		doc: compacted,
		bytes: utf8Length(JSON.stringify(compacted)),
		removed
	}
}

// ── Flush ────────────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true
	}

	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
		return false
	}

	const aRecord = a as Record<string, unknown>
	const bRecord = b as Record<string, unknown>
	const keys = Object.keys(aRecord)

	if (keys.length !== Object.keys(bRecord).length) {
		return false
	}

	for (const key of keys) {
		if (!Object.hasOwn(bRecord, key) || !deepEqual(aRecord[key], bRecord[key])) {
			return false
		}
	}

	return true
}

export interface WatchStateReconcile {
	// The new head; also the new local state
	doc: WatchStateDoc
	bytes: number
	// The head differs from `remote` and must be uploaded
	upload: boolean
}

// The flush step: compact(merge(local, remote)), compared against the remote head after compaction, so a replica that
// adds nothing never uploads and two replicas never undo each other's compaction.
export function reconcileWatchState({
	local,
	remote,
	limitBytes,
	hardLimitBytes
}: {
	local: WatchStateDoc
	remote: WatchStateDoc
	limitBytes?: number
	hardLimitBytes?: number
}): WatchStateReconcile {
	const { doc, bytes } = compactWatchState({
		doc: mergeWatchState({
			local,
			remote
		}).doc,
		...(limitBytes === undefined
			? {}
			: {
					limitBytes
				}),
		...(hardLimitBytes === undefined
			? {}
			: {
					hardLimitBytes
				})
	})

	return {
		doc,
		bytes,
		upload: doc !== remote && !deepEqual(doc, remote)
	}
}
