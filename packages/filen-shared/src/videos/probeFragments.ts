import type { BlockSource } from "./blockSource"
import { MalformedError, ascii, int32, readBytes, uint32, uint64 } from "./probeBytes"

// A fragmented MP4 (fMP4) keeps its sample tables in `moof` boxes spread through the file, so neither its
// duration (when no `mehd` states it) nor its keyframes come from the `moov`. The `mfra` box at the end
// indexes each track's sync samples (`tfra`) and is found from the `mfro` that closes the file, which gives
// its size: one read of the file's tail, usually inside the block holding the `mfro`. A keyframe is then its
// fragment's `moof` read and walked to the sample, and the duration is where the last fragment ends.

// An mfra past this is not worth a probe's budget: a two-hour film fragmented per 2 s GOP indexes about
// 3600 keyframes of 19-27 bytes per track.
export const MAX_MFRA_BYTES = 4 * 1_048_576
// A fragment's moof: trun entries of up to 16 bytes per sample, a few thousand samples.
export const MAX_MOOF_BYTES = 1_048_576

// tfhd flags (ISO/IEC 14496-12 8.8.7).
const TFHD_BASE_DATA_OFFSET = 0x1
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2
const TFHD_DEFAULT_DURATION = 0x8
const TFHD_DEFAULT_SIZE = 0x10
const TFHD_DEFAULT_FLAGS = 0x20
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000
// trun flags (8.8.8).
const TRUN_DATA_OFFSET = 0x1
const TRUN_FIRST_SAMPLE_FLAGS = 0x4
const TRUN_DURATION = 0x100
const TRUN_SIZE = 0x200
const TRUN_FLAGS = 0x400
const TRUN_COMPOSITION_OFFSET = 0x800

// One track's `tfra`: its sync samples in file order, each with the fragment that holds it. Times are in
// the track's media timescale (mdhd); the numbers are 1-based, as the box counts them.
export interface FragmentRandomAccess {
	track: number
	times: Float64Array
	moofs: Float64Array
	trafs: Uint32Array
	truns: Uint32Array
	samples: Uint32Array
	// Times never decrease, so a binary search finds the keyframe for a time.
	ordered: boolean
}

// A track's `trex` defaults, the last resort for a fragment that states neither per-sample nor tfhd values.
export interface FragmentDefaults {
	duration: number
	size: number
}

// What a fragmented file's tail and moov say, for its keyframes and duration.
export interface FragmentIndex {
	access: Map<number, FragmentRandomAccess>
	defaults: Map<number, FragmentDefaults>
	// mdhd timescale per track ID.
	timescales: Map<number, number>
}

interface Child {
	type: string
	dataStart: number
	end: number
}

// The boxes inside [start, end) of an in-memory buffer, 32- and 64-bit sizes alike; stops at the first that
// does not fit.
function* children(bytes: Uint8Array, start: number, end: number): Generator<Child> {
	let at = start

	while (at + 8 <= end) {
		const size32 = uint32(bytes, at)
		let size: number | null = size32
		let dataStart = at + 8

		if (size32 === 1) {
			size = at + 16 <= end ? uint64(bytes, at + 8) : null
			dataStart = at + 16
		} else if (size32 === 0) {
			size = end - at
		}

		if (size === null || size < dataStart - at || at + size > end) {
			return
		}

		yield { type: ascii(bytes, at + 4, at + 8), dataStart, end: at + size }

		at += size
	}
}

// A tfra payload (after its box header). Null when the entries do not fit the box.
export function parseTfra(bytes: Uint8Array, start: number, end: number): FragmentRandomAccess | null {
	if (end - start < 16) {
		return null
	}

	const version = bytes[start] ?? 0
	const track = uint32(bytes, start + 4)
	const lengths = uint32(bytes, start + 8)
	const trafBytes = ((lengths >> 4) & 0x3) + 1
	const trunBytes = ((lengths >> 2) & 0x3) + 1
	const sampleBytes = (lengths & 0x3) + 1
	const count = uint32(bytes, start + 12)
	const wide = version === 1 ? 8 : 4
	const entryBytes = wide * 2 + trafBytes + trunBytes + sampleBytes

	if (count * entryBytes > end - start - 16) {
		return null
	}

	const access: FragmentRandomAccess = {
		track,
		times: new Float64Array(count),
		moofs: new Float64Array(count),
		trafs: new Uint32Array(count),
		truns: new Uint32Array(count),
		samples: new Uint32Array(count),
		ordered: true
	}
	const sized = (at: number, length: number): number => {
		let value = 0

		for (let i = 0; i < length; i++) {
			value = value * 256 + (bytes[at + i] ?? 0)
		}

		return value
	}

	for (let i = 0, at = start + 16; i < count; i++) {
		const time = wide === 8 ? uint64(bytes, at) : uint32(bytes, at)
		const moof = wide === 8 ? uint64(bytes, at + 8) : uint32(bytes, at + 4)

		if (time === null || moof === null) {
			return null
		}

		at += wide * 2
		access.times[i] = time
		access.moofs[i] = moof
		access.trafs[i] = sized(at, trafBytes)
		at += trafBytes
		access.truns[i] = sized(at, trunBytes)
		at += trunBytes
		access.samples[i] = sized(at, sampleBytes)
		at += sampleBytes

		if (i > 0 && time < (access.times[i - 1] ?? 0)) {
			access.ordered = false
		}
	}

	return access
}

// An mfra payload's tfra boxes by track ID.
export function parseMfra(bytes: Uint8Array, start: number, end: number): Map<number, FragmentRandomAccess> {
	const access = new Map<number, FragmentRandomAccess>()

	for (const child of children(bytes, start, end)) {
		if (child.type !== "tfra") {
			continue
		}

		const parsed = parseTfra(bytes, child.dataStart, child.end)

		if (parsed !== null && !access.has(parsed.track)) {
			access.set(parsed.track, parsed)
		}
	}

	return access
}

// The mfra a file ends with, by track. Null when the file does not end with an mfro naming an mfra (or one
// too large to read). Budget errors and failed downloads throw.
export async function readMfra(source: BlockSource, maxBytes = MAX_MFRA_BYTES): Promise<Map<number, FragmentRandomAccess> | null> {
	if (source.size < 16) {
		return null
	}

	const mfro = await readBytes(source, source.size - 16, 16)
	const mfraSize = uint32(mfro, 12)

	if (ascii(mfro, 4, 8) !== "mfro" || mfraSize < 24 || mfraSize > source.size || mfraSize > maxBytes) {
		return null
	}

	const mfra = await readBytes(source, source.size - mfraSize, mfraSize)

	if (uint32(mfra, 0) !== mfraSize || ascii(mfra, 4, 8) !== "mfra") {
		return null
	}

	return parseMfra(mfra, 8, mfraSize)
}

// The moof at `offset`, read whole. Throws MalformedError for anything else there.
export async function readMoof(source: BlockSource, offset: number): Promise<Uint8Array> {
	if (offset + 8 > source.size) {
		throw new MalformedError("moof past the file")
	}

	const head = await readBytes(source, offset, Math.min(16, source.size - offset))
	const size32 = uint32(head, 0)
	const size = size32 === 1 ? (head.length >= 16 ? uint64(head, 8) : null) : size32

	if (ascii(head, 4, 8) !== "moof" || size === null || size < 16 || size > MAX_MOOF_BYTES || offset + size > source.size) {
		throw new MalformedError("no readable moof")
	}

	return readBytes(source, offset, size)
}

interface TrackFragmentHeader {
	track: number
	flags: number
	baseDataOffset: number | null
	defaultDuration: number | null
	defaultSize: number | null
}

function parseTfhd(bytes: Uint8Array, start: number, end: number): TrackFragmentHeader | null {
	if (end - start < 8) {
		return null
	}

	const flags = uint32(bytes, start) & 0xffffff
	const header: TrackFragmentHeader = {
		track: uint32(bytes, start + 4),
		flags,
		baseDataOffset: null,
		defaultDuration: null,
		defaultSize: null
	}
	let at = start + 8

	if ((flags & TFHD_BASE_DATA_OFFSET) !== 0) {
		header.baseDataOffset = uint64(bytes, at)
		at += 8

		if (header.baseDataOffset === null) {
			return null
		}
	}

	if ((flags & TFHD_SAMPLE_DESCRIPTION_INDEX) !== 0) {
		at += 4
	}

	if ((flags & TFHD_DEFAULT_DURATION) !== 0) {
		header.defaultDuration = uint32(bytes, at)
		at += 4
	}

	if ((flags & TFHD_DEFAULT_SIZE) !== 0) {
		header.defaultSize = uint32(bytes, at)
		at += 4
	}

	if ((flags & TFHD_DEFAULT_FLAGS) !== 0) {
		at += 4
	}

	return at <= end ? header : null
}

// A trun's sample walk: per-sample fields in order, so one sample's duration and size are read in place.
interface RunLayout {
	count: number
	// Absolute data_offset field, or null without one.
	dataOffset: number | null
	// First sample's entry, and the bytes per entry.
	entries: number
	stride: number
	duration: number | null
	size: number | null
}

function runLayout(bytes: Uint8Array, start: number, end: number): RunLayout | null {
	if (end - start < 8) {
		return null
	}

	const flags = uint32(bytes, start) & 0xffffff
	const count = uint32(bytes, start + 4)
	let at = start + 8
	let dataOffset: number | null = null

	if ((flags & TRUN_DATA_OFFSET) !== 0) {
		dataOffset = int32(bytes, at)
		at += 4
	}

	if ((flags & TRUN_FIRST_SAMPLE_FLAGS) !== 0) {
		at += 4
	}

	let stride = 0
	const field = (flag: number): number | null => {
		if ((flags & flag) === 0) {
			return null
		}

		stride += 4

		return stride - 4
	}
	const duration = field(TRUN_DURATION)
	const size = field(TRUN_SIZE)

	field(TRUN_FLAGS)
	field(TRUN_COMPOSITION_OFFSET)

	if (at + count * stride > end) {
		return null
	}

	return { count, dataOffset, entries: at, stride, duration, size }
}

function sampleField(bytes: Uint8Array, run: RunLayout, index: number, field: number | null, fallback: number | null): number | null {
	return field === null ? fallback : uint32(bytes, run.entries + index * run.stride + field)
}

// Where the last fragment of `moof` ends for its tracks, in seconds: each traf's tfdt plus its samples'
// durations, over the track's timescale; the latest of them. Null when no traf can say.
export function fragmentEnd(moof: Uint8Array, index: Pick<FragmentIndex, "defaults" | "timescales">): number | null {
	let latest: number | null = null

	for (const traf of children(moof, 8, moof.length)) {
		if (traf.type !== "traf") {
			continue
		}

		let header: TrackFragmentHeader | null = null
		let base: number | null = null
		let total = 0
		let complete = true

		for (const child of children(moof, traf.dataStart, traf.end)) {
			if (child.type === "tfhd") {
				header = parseTfhd(moof, child.dataStart, child.end)
			} else if (child.type === "tfdt" && child.end - child.dataStart >= 8) {
				base = (moof[child.dataStart] ?? 0) === 1 ? uint64(moof, child.dataStart + 4) : uint32(moof, child.dataStart + 4)
			} else if (child.type === "trun" && header !== null) {
				const run = runLayout(moof, child.dataStart, child.end)
				const fallback = header.defaultDuration ?? index.defaults.get(header.track)?.duration ?? null

				if (run === null || (run.duration === null && fallback === null)) {
					complete = false

					continue
				}

				for (let i = 0; i < run.count; i++) {
					total += sampleField(moof, run, i, run.duration, fallback) ?? 0
				}
			}
		}

		const timescale = header === null ? undefined : index.timescales.get(header.track)

		if (header === null || base === null || !complete || timescale === undefined || timescale <= 0) {
			continue
		}

		const end = (base + total) / timescale

		latest = latest === null ? end : Math.max(latest, end)
	}

	return latest
}

// The bytes of the 1-based sample `sample` of trun `trun` in traf `traf` of a moof that starts at
// `moofStart`, for `track`. Null when the moof does not hold it the way the tfra said.
export function locateSample(
	moof: Uint8Array,
	moofStart: number,
	at: { track: number; traf: number; trun: number; sample: number },
	defaults: FragmentDefaults | undefined
): { offset: number; size: number } | null {
	let trafNumber = 0

	for (const traf of children(moof, 8, moof.length)) {
		if (traf.type !== "traf" || ++trafNumber !== at.traf) {
			continue
		}

		let header: TrackFragmentHeader | null = null
		// The traf's base data offset, and where the next trun's data starts when it states no offset.
		let base: number | null = null
		let cursor: number | null = null
		let trunNumber = 0

		for (const child of children(moof, traf.dataStart, traf.end)) {
			if (child.type === "tfhd") {
				header = parseTfhd(moof, child.dataStart, child.end)

				if (header?.track !== at.track) {
					return null
				}

				// Without an explicit base, only the first traf (or one flagged default-base-is-moof) starts at the moof.
				base = header.baseDataOffset ?? ((header.flags & TFHD_DEFAULT_BASE_IS_MOOF) !== 0 || at.traf === 1 ? moofStart : null)
				cursor = base
			} else if (child.type === "trun" && header !== null) {
				const run = runLayout(moof, child.dataStart, child.end)

				if (run === null) {
					return null
				}

				let offset: number | null = run.dataOffset === null ? cursor : base === null ? null : base + run.dataOffset
				const fallback = header.defaultSize ?? defaults?.size ?? null

				if (offset === null || (run.size === null && fallback === null)) {
					return null
				}

				const target = ++trunNumber === at.trun ? at.sample : 0

				for (let i = 0; i < run.count; i++) {
					const size = sampleField(moof, run, i, run.size, fallback) ?? 0

					if (i + 1 === target) {
						return size > 0 ? { offset, size } : null
					}

					offset += size
				}

				if (target !== 0) {
					return null
				}

				cursor = offset
			}
		}

		return null
	}

	return null
}

// The index entry for `ticks`: the last sync sample at or before it, or the first when every one is later;
// -1 for none.
export function accessAtOrBefore(access: FragmentRandomAccess, ticks: number): number {
	const { times } = access
	const count = times.length

	if (count === 0) {
		return -1
	}

	if (access.ordered) {
		let low = 0
		let high = count - 1
		let found = 0

		while (low <= high) {
			const mid = (low + high) >>> 1

			if ((times[mid] ?? 0) <= ticks) {
				found = mid
				low = mid + 1
			} else {
				high = mid - 1
			}
		}

		return found
	}

	let best = -1
	let first = 0

	for (let i = 0; i < count; i++) {
		const time = times[i] ?? 0

		if (time < (times[first] ?? 0)) {
			first = i
		}

		if (time <= ticks && (best === -1 || time >= (times[best] ?? 0))) {
			best = i
		}
	}

	return best === -1 ? first : best
}

// The latest moof any tfra points at: the file's last fragment, whose end is the file's duration.
export function lastMoof(access: Map<number, FragmentRandomAccess>): number | null {
	let last: number | null = null

	for (const track of access.values()) {
		const { moofs } = track

		for (let i = 0; i < moofs.length; i++) {
			const moof = moofs[i] ?? 0

			last = last === null ? moof : Math.max(last, moof)
		}
	}

	return last
}
