// The synced Videos library configuration, `.filen/videos/library.v1.json`: which directories are library roots
// (and how each is classified), library preferences, and manual corrections. Written rarely, by any device.
//
// Built from the watch state's register records: each root, preference and correction is a record of
// last-writer-wins registers stamped with a hybrid logical clock and a writer id, and removing one writes a
// tombstone, so concurrent edits of different fields both survive and a merge with an older copy never brings a
// removed entry back. Records, registers and fields this version doesn't know (a root type added later, say) are
// carried through verbatim, so an older client rewriting the file never drops or rewrites what a newer one wrote.

import type { LibraryRootType } from "./classify"
import {
	hasLiveRegister,
	mergeRecordMaps,
	mergeUnknownFields,
	parseRegisterRecord,
	serializeCanonical,
	setRegister,
	tombstoneRecord,
	type Hlc,
	type RegisterRecord,
	type Stamp,
	type ValueRegister
} from "./registerRecords"

// Its name under `.filen`, as DOT_FILEN_SUBDIRS (dotFilen.ts) names it.
export const VIDEOS_DIR_NAME = "videos"
export const LIBRARY_CONFIG_FILE_NAME = "library.v1.json"

const ROOT_TYPES: ReadonlySet<unknown> = new Set<LibraryRootType>(["auto", "movies", "shows", "other"])

// ty: root type, en: enabled, ad: wall-clock ms the root was added (orders the roots).
export interface LibraryRootRecord extends RegisterRecord {
	ty?: ValueRegister<unknown>
	en?: ValueRegister<unknown>
	ad?: ValueRegister<unknown>
}

export interface LibraryPrefRecord extends RegisterRecord {
	p?: ValueRegister<unknown>
}

// A manual correction, keyed `d:<directory uuid>` (a title with its own directory, a series) or
// `s:<stable uuid>` (a single file, an episode by its first file); one register, edited as a whole.
export interface LibraryOverride {
	title?: string
	year?: number
	// What the item is shown as. "episode" needs `season` and `episode`; "series" is reserved.
	kind?: "movie" | "series" | "other" | "episode"
	season?: number
	episode?: number
	// Last episode a multi-episode file holds (`episode` when absent).
	episodeEnd?: number
	hidden?: boolean
	// Key of the title this one is shown as part of: the series a series is merged into, or an episode belongs to.
	mergeInto?: string
	// Stored under `m:<merge key>`: same-titled series in different roots are kept apart instead of merged.
	split?: boolean
}

const OVERRIDE_KINDS: ReadonlySet<unknown> = new Set(["movie", "series", "other", "episode"])

function isOverrideKind(value: unknown): value is NonNullable<LibraryOverride["kind"]> {
	return OVERRIDE_KINDS.has(value)
}
const MAX_OVERRIDE_TITLE = 256

export interface LibraryOverrideRecord extends RegisterRecord {
	o?: Stamp & LibraryOverride & Record<string, unknown>
}

export interface LibraryConfigDoc {
	v: 1
	roots: Record<string, LibraryRootRecord>
	prefs: Record<string, LibraryPrefRecord>
	overrides: Record<string, LibraryOverrideRecord>
	[key: string]: unknown
}

const DOC_FIELDS: ReadonlySet<string> = new Set(["v", "roots", "prefs", "overrides"])

export function emptyLibraryConfig(): LibraryConfigDoc {
	return {
		v: 1,
		roots: {},
		prefs: {},
		overrides: {}
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSection<T extends RegisterRecord>(value: unknown): Record<string, T> {
	const out: Record<string, T> = {}

	if (!isObject(value)) {
		return out
	}

	for (const key in value) {
		const record = key === "__proto__" ? null : parseRegisterRecord(value[key])

		if (record !== null) {
			out[key] = record as T
		}
	}

	return out
}

// null when the value isn't a version-1 library document at all.
export function parseLibraryConfig(value: unknown): LibraryConfigDoc | null {
	if (!isObject(value) || value["v"] !== 1) {
		return null
	}

	return {
		...value,
		v: 1,
		roots: parseSection(value["roots"]),
		prefs: parseSection(value["prefs"]),
		overrides: parseSection(value["overrides"])
	}
}

export function parseLibraryConfigText(text: string): LibraryConfigDoc | null {
	try {
		return parseLibraryConfig(JSON.parse(text) as unknown)
	} catch {
		return null
	}
}

export interface LibraryConfigMerge {
	doc: LibraryConfigDoc
	// local holds something remote lacks: an upload is due
	localContributed: boolean
	// remote holds something local lacks
	remoteContributed: boolean
}

// Register-wise merge; associative, commutative and idempotent.
export function mergeLibraryConfig({ local, remote }: { local: LibraryConfigDoc; remote: LibraryConfigDoc }): LibraryConfigMerge {
	const roots = mergeRecordMaps({ local: local.roots, remote: remote.roots })
	const prefs = mergeRecordMaps({ local: local.prefs, remote: remote.prefs })
	const overrides = mergeRecordMaps({ local: local.overrides, remote: remote.overrides })
	const fields = mergeUnknownFields({ local, remote, known: DOC_FIELDS })
	const parts = [roots, prefs, overrides, fields]

	return {
		doc: {
			...fields.value,
			v: 1,
			roots: roots.value,
			prefs: prefs.value,
			overrides: overrides.value
		},
		localContributed: parts.some(part => part.localContributed),
		remoteContributed: parts.some(part => part.remoteContributed)
	}
}

// The newest stamp in the document, for the clock to observe after a read.
export function libraryConfigMaxStamp(doc: LibraryConfigDoc): Hlc {
	let max = 0

	for (const section of [doc.roots, doc.prefs, doc.overrides]) {
		for (const key in section) {
			const record: RegisterRecord | undefined = section[key]

			for (const field in record) {
				const value = record[field]

				if (isObject(value) && typeof value["t"] === "number") {
					max = Math.max(max, value["t"])
				}
			}
		}
	}

	return max
}

// Key-order independent, so two documents with equal content serialize equally.
export function serializeLibraryConfig(doc: LibraryConfigDoc): string {
	return serializeCanonical(doc)
}

export interface ActiveLibraryRoot {
	dirUuid: string
	type: LibraryRootType
	enabled: boolean
	added: number
}

// The roots that aren't removed, in the order they were added. A type this version doesn't know reads as auto.
export function activeLibraryRoots(doc: LibraryConfigDoc): ActiveLibraryRoot[] {
	const out: ActiveLibraryRoot[] = []

	for (const dirUuid in doc.roots) {
		const record = doc.roots[dirUuid]

		if (record?.ty === undefined) {
			continue
		}

		const type = record.ty.v
		const added = record.ad?.v

		out.push({
			dirUuid,
			type: ROOT_TYPES.has(type) ? (type as LibraryRootType) : "auto",
			enabled: record.en?.v !== false,
			added: typeof added === "number" ? added : 0
		})
	}

	return out.sort((a, b) => a.added - b.added || (a.dirUuid < b.dirUuid ? -1 : a.dirUuid > b.dirUuid ? 1 : 0))
}

export function libraryPref(doc: LibraryConfigDoc, key: string): unknown {
	return doc.prefs[key]?.p?.v
}

export function libraryOverride(doc: LibraryConfigDoc, key: string): LibraryOverride | null {
	return doc.overrides[key]?.o ?? null
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000
}

// The fields of a stored correction this version understands, each checked (the file is written by any device).
function cleanOverride(register: Record<string, unknown>): LibraryOverride {
	const out: LibraryOverride = {}
	const { title, year, kind, season, episode, episodeEnd, hidden, mergeInto, split } = register

	if (typeof title === "string" && title.trim().length > 0) {
		out.title = title.trim().slice(0, MAX_OVERRIDE_TITLE)
	}

	if (typeof year === "number" && Number.isInteger(year) && year >= 1800 && year <= 2200) {
		out.year = year
	}

	if (isOverrideKind(kind)) {
		out.kind = kind
	}

	if (isCount(season)) {
		out.season = season
	}

	if (isCount(episode)) {
		out.episode = episode
	}

	if (isCount(episodeEnd)) {
		out.episodeEnd = episodeEnd
	}

	if (hidden === true) {
		out.hidden = true
	}

	if (typeof mergeInto === "string" && mergeInto.length > 0) {
		out.mergeInto = mergeInto
	}

	if (split === true) {
		out.split = true
	}

	return out
}

// The stored correction under `key` as written, unknown fields included (what an edit must carry through); null
// when there is none.
export function rawLibraryOverride(doc: LibraryConfigDoc, key: string): Record<string, unknown> | null {
	const register = doc.overrides[key]?.o

	if (register === undefined) {
		return null
	}

	const { t: _t, d: _d, ...fields } = register

	return fields
}

// Every live correction, by key, with only the fields this version understands.
export function activeLibraryOverrides(doc: LibraryConfigDoc): Record<string, LibraryOverride> {
	const out: Record<string, LibraryOverride> = {}

	for (const key in doc.overrides) {
		const register = doc.overrides[key]?.o

		if (register !== undefined) {
			out[key] = cleanOverride(register)
		}
	}

	return out
}

// ── Edits ────────────────────────────────────────────────────────────────────

function withRecord<K extends "roots" | "prefs" | "overrides">(
	doc: LibraryConfigDoc,
	section: K,
	key: string,
	record: LibraryConfigDoc[K][string]
): LibraryConfigDoc {
	return {
		...doc,
		[section]: {
			...doc[section],
			[key]: record
		}
	}
}

function register<V>(stamp: Stamp, value: V): ValueRegister<V> {
	return {
		t: stamp.t,
		d: stamp.d,
		v: value
	}
}

// Adds a root (or brings a removed one back), or changes its type or enabled flag. Only the registers given and
// changed are written, so another device's concurrent edit of the other one survives, and a value this version
// doesn't know is left alone unless the edit replaces it. A new root defaults to auto, enabled.
export function withLibraryRoot({
	doc,
	dirUuid,
	type,
	enabled,
	stamp,
	now
}: {
	doc: LibraryConfigDoc
	dirUuid: string
	type?: LibraryRootType
	enabled?: boolean
	stamp: Stamp
	now: number
}): LibraryConfigDoc {
	const previous = doc.roots[dirUuid]
	const live = previous?.ty !== undefined
	let record = previous

	if (!live || (type !== undefined && previous.ty?.v !== type)) {
		record = setRegister({ rec: record, key: "ty", register: register(stamp, type ?? "auto") })
	}

	if (!live || (enabled !== undefined && previous.en?.v !== enabled)) {
		record = setRegister({ rec: record, key: "en", register: register(stamp, enabled ?? true) })
	}

	if (!live || previous.ad === undefined) {
		record = setRegister({ rec: record, key: "ad", register: register(stamp, now) })
	}

	return record === previous || record === undefined ? doc : withRecord(doc, "roots", dirUuid, record)
}

export function withoutLibraryRoot({
	doc,
	dirUuid,
	stamp,
	at
}: {
	doc: LibraryConfigDoc
	dirUuid: string
	stamp: Stamp
	at: number
}): LibraryConfigDoc {
	const record = doc.roots[dirUuid]

	if (record === undefined || !hasLiveRegister(record)) {
		return doc
	}

	return withRecord(doc, "roots", dirUuid, tombstoneRecord({ rec: record, stamp, at }))
}

// Sets (or, with `value` undefined, removes) a library preference.
export function withLibraryPref({
	doc,
	key,
	value,
	stamp,
	at
}: {
	doc: LibraryConfigDoc
	key: string
	value: unknown
	stamp: Stamp
	at: number
}): LibraryConfigDoc {
	const record = doc.prefs[key]

	return withRecord(
		doc,
		"prefs",
		key,
		value === undefined
			? tombstoneRecord({ rec: record, stamp, at })
			: setRegister({ rec: record, key: "p", register: register(stamp, value) })
	)
}

// Sets (or, with `override` null, removes) the correction stored under `key`.
export function withLibraryOverride({
	doc,
	key,
	override,
	stamp,
	at
}: {
	doc: LibraryConfigDoc
	key: string
	// Unknown fields (a newer version's) are written as given.
	override: LibraryOverride | Readonly<Record<string, unknown>> | null
	stamp: Stamp
	at: number
}): LibraryConfigDoc {
	const record = doc.overrides[key]

	return withRecord(
		doc,
		"overrides",
		key,
		override === null
			? tombstoneRecord({ rec: record, stamp, at })
			: setRegister({
					rec: record,
					key: "o",
					register: {
						...override,
						t: stamp.t,
						d: stamp.d
					}
				})
	)
}
