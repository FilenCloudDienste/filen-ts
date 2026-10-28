// Last-writer-wins registers for synced documents (the Videos watch state and library, the Photos library): each
// register is a stamped object, stamped by a hybrid logical clock and a writer id, grouped into records that a
// tombstone deletes. Replicas merge register by register, so every merge order converges on the same document, and
// a merge with an older copy never brings a deleted record back. Fields a version doesn't know are carried through.
// Generic, and exported from the package root too; it sits here because modules of this directory import siblings
// only.

const DAY_MS = 86_400_000

// ── Clock ────────────────────────────────────────────────────────────────────

export type Hlc = number

// physicalMs * HLC_SPAN + counter: number order is stamp order, and it stays below 2^53 until ~2255.
export const HLC_SPAN = 1000

// Observed stamps further ahead of now than this come from a broken clock; the local clock never follows them past it.
export const MAX_CLOCK_SKEW_MS = 365 * DAY_MS

export function hlcPhysicalMs(t: Hlc): number {
	return Math.floor(t / HLC_SPAN)
}

function physicalStamp(now: number): Hlc {
	return Number.isFinite(now) && now > 0 ? Math.floor(now) * HLC_SPAN : 0
}

// Stamp for a local write: strictly after everything this clock has issued or observed.
export function hlcTick({ clock, now }: { clock: Hlc; now: number }): Hlc {
	return Math.max(Math.floor(clock) + 1, physicalStamp(now))
}

// Clock after receiving `seen` (the highest stamp of a remote document), clamped to the skew window.
export function hlcObserve({ clock, seen, now }: { clock: Hlc; seen: Hlc; now: number }): Hlc {
	return Math.max(clock, Math.min(seen, physicalStamp(now) + MAX_CLOCK_SKEW_MS * HLC_SPAN), physicalStamp(now))
}

// d is the writer id and must be unique per writer: two writers sharing one (say, two tabs of one browser) can issue
// the same stamp for different values, and one of them is then silently lost. Use "<device id>.<tab id>" with no "." in
// the device id: compaction reads the device from it.
export interface Stamp {
	t: Hlc
	d: string
}

// Deletion: every other register of the record stamped at or before (t, d) is gone. e = wall-clock ms the deletion
// was decided at (a document may expire a record left with only its tombstone some time after it).
export interface Tombstone extends Stamp {
	e: number
	[key: string]: unknown
}

// A record of last-writer-wins registers (stamped objects) with an optional tombstone. The watch state's items and
// series are such records; other synced documents built from them merge through the same functions below.
export interface RegisterRecord {
	x?: Tombstone
	[key: string]: unknown
}

export const MAX_ID_LENGTH = 128
export const UNSAFE_KEY = "__proto__"

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function isStamped(value: unknown): value is Stamp {
	return isRecord(value) && typeof value["t"] === "number" && typeof value["d"] === "string"
}

export function hasValidStamp(value: unknown): value is Record<string, unknown> & Stamp {
	return isRecord(value) && isCount(value["t"]) && isId(value["d"])
}

export function compareStamps(a: Stamp, b: Stamp): number {
	if (a.t !== b.t) {
		return a.t > b.t ? 1 : -1
	}

	return a.d === b.d ? 0 : a.d > b.d ? 1 : -1
}

// Drops what a tombstone covers: registers stamped at or before it, and every unstamped field (which has no time to
// outlive it; letting one survive would make the result depend on merge order). Returns the record itself when
// nothing is covered.
export function normalizeRecord<T extends RegisterRecord>(rec: T): T {
	const x = rec.x

	if (x === undefined) {
		return rec
	}

	let out: Record<string, unknown> | null = null

	for (const key in rec) {
		const value = rec[key]

		if (key !== "x" && (!isStamped(value) || compareStamps(value, x) <= 0)) {
			out ??= {
				...rec
			}

			delete out[key]
		}
	}

	return (out ?? rec) as T
}

// Total order on field values: stamp, then serialized content, so equal stamps (or fields without one) still resolve
// identically on every replica.
export function compareValues(a: unknown, b: unknown): number {
	const aStamped = isStamped(a)
	const bStamped = isStamped(b)

	if (aStamped !== bStamped) {
		return aStamped ? 1 : -1
	}

	if (aStamped && bStamped) {
		const order = compareStamps(a, b)

		if (order !== 0) {
			return order
		}
	}

	const aJson = JSON.stringify(a)
	const bJson = JSON.stringify(b)

	return aJson === bJson ? 0 : aJson > bJson ? 1 : -1
}

// a/b: whether each side supplied something the other lacked.
export interface MergeFlags {
	a: boolean
	b: boolean
}

function sameFields(result: Record<string, unknown>, side: Record<string, unknown>): boolean {
	let count = 0

	for (const key in result) {
		if (!Object.hasOwn(side, key)) {
			return false
		}

		const value = result[key]
		const other = side[key]

		if (value !== other && compareValues(value, other) !== 0) {
			return false
		}

		count++
	}

	return count === Object.keys(side).length
}

// Field-wise join of one record, then tombstone pruning. Returns a side unchanged when the result equals it.
function mergeRecords(a: RegisterRecord, b: RegisterRecord, flags: MergeFlags): RegisterRecord {
	if (a === b) {
		return a
	}

	const joined: RegisterRecord = {}

	for (const key in a) {
		const value = a[key]

		if (!Object.hasOwn(b, key)) {
			joined[key] = value

			continue
		}

		const other = b[key]

		joined[key] = value === other || compareValues(value, other) >= 0 ? value : other
	}

	for (const key in b) {
		if (!Object.hasOwn(a, key)) {
			joined[key] = b[key]
		}
	}

	const result = normalizeRecord(joined)
	const fromA = !sameFields(result, b)
	const fromB = !sameFields(result, a)

	flags.a ||= fromA
	flags.b ||= fromB

	return !fromB ? a : !fromA ? b : result
}

export function mergeMaps<T extends RegisterRecord>(a: Record<string, T>, b: Record<string, T>, flags: MergeFlags): Record<string, T> {
	if (a === b) {
		return a
	}

	const outerA = flags.a
	const outerB = flags.b
	const out: Record<string, T> = {}

	flags.a = false
	flags.b = false

	for (const key in a) {
		const value = a[key] as T
		const other = b[key]

		if (!Object.hasOwn(b, key) || other === undefined) {
			out[key] = value
			flags.a = true

			continue
		}

		out[key] = mergeRecords(value, other, flags) as T
	}

	for (const key in b) {
		if (!Object.hasOwn(a, key)) {
			out[key] = b[key] as T
			flags.b = true
		}
	}

	const fromA = flags.a
	const fromB = flags.b

	flags.a = outerA || fromA
	flags.b = outerB || fromB

	return !fromB ? a : !fromA ? b : out
}

function pickField(a: unknown, b: unknown, flags: MergeFlags): unknown {
	const order = a === b ? 0 : compareValues(a, b)

	flags.a ||= order > 0
	flags.b ||= order < 0

	return order < 0 ? b : a
}

// Fields of a document this version doesn't know: kept from both sides, one picked deterministically where both
// have one.
export function mergeFields(
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
	known: ReadonlySet<string>,
	into: Record<string, unknown>,
	flags: MergeFlags
): void {
	for (const key in local) {
		if (known.has(key)) {
			continue
		}

		if (!Object.hasOwn(remote, key)) {
			into[key] = local[key]
			flags.a = true

			continue
		}

		into[key] = pickField(local[key], remote[key], flags)
	}

	for (const key in remote) {
		if (!known.has(key) && !Object.hasOwn(local, key)) {
			into[key] = remote[key]
			flags.b = true
		}
	}
}

export interface RegisterDocMerge<T> {
	value: T
	// local holds something remote lacks
	localContributed: boolean
	// remote holds something local lacks
	remoteContributed: boolean
}

// Register-wise merge of two maps of register records (associative, commutative, idempotent).
export function mergeRecordMaps<T extends RegisterRecord>({
	local,
	remote
}: {
	local: Record<string, T>
	remote: Record<string, T>
}): RegisterDocMerge<Record<string, T>> {
	const flags: MergeFlags = {
		a: false,
		b: false
	}
	const value = mergeMaps(local, remote, flags)

	return {
		value,
		localContributed: flags.a,
		remoteContributed: flags.b
	}
}

// The document fields outside `known`, merged like the watch state's own unknown fields.
export function mergeUnknownFields({
	local,
	remote,
	known
}: {
	local: Record<string, unknown>
	remote: Record<string, unknown>
	known: ReadonlySet<string>
}): RegisterDocMerge<Record<string, unknown>> {
	const flags: MergeFlags = {
		a: false,
		b: false
	}
	const value: Record<string, unknown> = {}

	mergeFields(local, remote, known, value, flags)

	return {
		value,
		localContributed: flags.a,
		remoteContributed: flags.b
	}
}

// Sets one register of a record; registers a newer tombstone covers fall away.
export function setRegister<T extends RegisterRecord>({ rec, key, register }: { rec: T | undefined; key: string; register: Stamp }): T {
	return normalizeRecord({
		...rec,
		[key]: {
			...register,
			...checkedStamp(register)
		}
	} as T)
}

// Deletes a record as of `stamp`: every register stamped at or before it goes, later writes survive. `at` is the
// deciding device's wall clock.
export function tombstoneRecord<T extends RegisterRecord>({ rec, stamp, at }: { rec: T | undefined; stamp: Stamp; at: number }): T {
	return tombstoneAt((rec ?? {}) as T, checkedStamp(stamp), at)
}

// Whether any register of the record outlives its tombstone.
export function hasLiveRegister(rec: RegisterRecord): boolean {
	for (const key in rec) {
		if (key !== "x") {
			return true
		}
	}

	return false
}

// A record as parsed from an untrusted document: an object whose stamped registers are kept as they are (unknown
// ones included, so a newer writer's fields survive) and whose malformed stamps are dropped. null for a non-object.
export function parseRegisterRecord(value: unknown): RegisterRecord | null {
	if (!isRecord(value)) {
		return null
	}

	const out: RegisterRecord = {}

	for (const key in value) {
		const field = value[key]

		if (key === UNSAFE_KEY || !hasValidStamp(field) || (key === "x" && !isNonNegative(field["e"]))) {
			continue
		}

		out[key] = field
	}

	return normalizeRecord(out)
}

export function checkedStamp(stamp: Stamp): Stamp {
	if (!isCount(stamp.t) || !isId(stamp.d)) {
		throw new RangeError("Invalid register stamp")
	}

	return {
		t: stamp.t,
		d: stamp.d
	}
}

export function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0
}

export function tombstoneAt<T extends RegisterRecord>(rec: T, stamp: Stamp, decidedAtMs: number): T {
	return normalizeRecord({
		...rec,
		x: {
			t: stamp.t,
			d: stamp.d,
			e: nonNegative(decidedAtMs)
		}
	})
}

// A register holding one value.
export interface ValueRegister<V> extends Stamp {
	v: V
	[key: string]: unknown
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical)
	}

	if (!isRecord(value)) {
		return value
	}

	const out: Record<string, unknown> = {}

	for (const key of Object.keys(value).sort()) {
		out[key] = canonical(value[key])
	}

	return out
}

// Key-order independent, so two documents with equal content serialize equally.
export function serializeCanonical(value: unknown): string {
	return JSON.stringify(canonical(value))
}
