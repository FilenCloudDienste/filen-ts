import type { BlockSource } from "./blockSource"
import { MalformedError, readBytes, uint32, uint64 } from "./probeBytes"
import { ebmlChildren, ebmlUint, parseElementHeader, type EbmlContext, type EbmlElement } from "./probeEbml"
import { pictureTrack, walkContainer } from "./probe"
import { accessAtOrBefore, locateSample, readMoof, type FragmentIndex } from "./probeFragments"
import type { ByteRange, CuesLocation, ParsedContainer, ProbeVideo, SampleTables, VideoDecodeInfo } from "./probeTypes"

// Keyframes located with the probe's own walkers, reading only the index bytes a lookup needs: an MP4's
// sample tables (stts/stss/stsc entries, one chunk offset, the sizes up to the sample), a fragmented MP4's
// mfra plus the moof of the fragment it points at, or a Matroska's Cues plus the header of the block they
// point at. One keyframe is then a single ranged read.

// One keyframe's bytes in the file, and when it is shown.
export interface KeyframeRef {
	offset: number
	size: number
	timeSec: number
}

// What VideoDecoder.configure takes for the picture track.
export interface DecoderSetup {
	codec: string
	codedWidth: number
	codedHeight: number
	description: Uint8Array | null
}

export interface KeyframeIndex {
	durationSec: number | null
	video: ProbeVideo
	decoder: DecoderSetup
	// The last keyframe at or before `timeSec` (the first one before any), or null when the index has none.
	keyframeAt(timeSec: number): Promise<KeyframeRef | null>
}

// A frame too large to be worth a thumbnail's download.
export const MAX_KEYFRAME_BYTES = 8 * 1_048_576
// Matches the probe's Cues cap.
const MAX_CUES_BYTES = 8 * 1_048_576
// stts, stss and stsc are read whole; past this the track is too irregular for a thumbnail's budget.
const MAX_TABLE_BYTES = 1_048_576
// The sizes read to find a sample's place in its chunk.
const MAX_CHUNK_SIZE_BYTES = 65_536
// Children of a Cluster looked at for the keyframe when the Cues give no relative position.
const MAX_CLUSTER_CHILDREN = 64

const CUES_ID = 0x1c53bb6b
const CUE_POINT_ID = 0xbb
const CUE_TIME_ID = 0xb3
const CUE_TRACK_POSITIONS_ID = 0xb7
const CUE_TRACK_ID = 0xf7
const CUE_CLUSTER_POSITION_ID = 0xf1
const CUE_RELATIVE_POSITION_ID = 0xf0
const CLUSTER_ID = 0x1f43b675
const SIMPLE_BLOCK_ID = 0xa3
const BLOCK_GROUP_ID = 0xa0
const BLOCK_ID = 0xa1
const REFERENCE_BLOCK_ID = 0xfb

// ── MP4 sample tables ───────────────────────────────────────────────────────

// stts entries (sample_count, sample_delta): the 1-based sample shown at `ticks` (the last one starting at
// or before it), clamped to the track's samples; 0 for an empty table.
export function sampleAtTime(stts: Uint8Array, ticks: number): number {
	let time = 0
	let sample = 0

	for (let at = 0; at + 8 <= stts.length; at += 8) {
		const count = uint32(stts, at)
		const delta = uint32(stts, at + 4)

		if (count === 0) {
			continue
		}

		if (delta > 0 && time + count * delta > ticks) {
			return sample + Math.max(1, Math.floor((ticks - time) / delta) + 1)
		}

		time += count * delta
		sample += count
	}

	return sample
}

// The decode time of 1-based `sample`, in ticks.
export function sampleTime(stts: Uint8Array, sample: number): number {
	let time = 0
	let first = 1

	for (let at = 0; at + 8 <= stts.length; at += 8) {
		const count = uint32(stts, at)
		const delta = uint32(stts, at + 4)

		if (sample < first + count) {
			return time + (sample - first) * delta
		}

		time += count * delta
		first += count
	}

	return time
}

// The last sync sample at or before `sample` in an stss entry list (ascending sample numbers), or the
// first one when none precedes it; null for an empty list.
export function syncSampleAtOrBefore(stss: Uint8Array, sample: number): number | null {
	const count = Math.floor(stss.length / 4)

	if (count === 0) {
		return null
	}

	let low = 0
	let high = count - 1
	let found = -1

	while (low <= high) {
		const mid = (low + high) >>> 1

		if (uint32(stss, mid * 4) <= sample) {
			found = mid
			low = mid + 1
		} else {
			high = mid - 1
		}
	}

	return uint32(stss, Math.max(0, found) * 4)
}

// The 1-based chunk holding `sample` and the chunk's first sample, from stsc entries (first_chunk,
// samples_per_chunk, sample_description_index); null when the table does not reach the sample.
export function chunkOfSample(stsc: Uint8Array, sample: number): { chunk: number; firstSample: number } | null {
	let firstSample = 1

	for (let at = 0; at + 12 <= stsc.length; at += 12) {
		const firstChunk = uint32(stsc, at)
		const perChunk = uint32(stsc, at + 4)
		const nextChunk = at + 24 <= stsc.length ? uint32(stsc, at + 12) : Number.POSITIVE_INFINITY

		if (perChunk === 0 || firstChunk === 0 || nextChunk <= firstChunk) {
			return null
		}

		const runSamples = (nextChunk - firstChunk) * perChunk

		if (sample < firstSample + runSamples) {
			const index = Math.floor((sample - firstSample) / perChunk)

			return { chunk: firstChunk + index, firstSample: firstSample + index * perChunk }
		}

		firstSample += runSamples
	}

	return null
}

// A full box's entries after its version/flags and entry count, read whole under `cap`.
async function tableEntries(source: BlockSource, range: ByteRange, entryBytes: number, cap: number): Promise<Uint8Array> {
	if (range.end - range.start < 8) {
		throw new MalformedError("sample table too short")
	}

	const count = uint32(await readBytes(source, range.start + 4, 4), 0)
	const length = count * entryBytes

	if (length > cap || range.start + 8 + length > range.end) {
		throw new MalformedError("sample table past its box")
	}

	return readBytes(source, range.start + 8, length)
}

interface Mp4Loaded {
	stts: Uint8Array
	stss: Uint8Array | null
	stsc: Uint8Array
}

function mp4Index(source: BlockSource, tables: SampleTables): ((timeSec: number) => Promise<KeyframeRef | null>) | null {
	const { stts, stsc, stsz, chunkOffsets, stss, timescale, wideOffsets } = tables

	if (stts === null || stsc === null || stsz === null || chunkOffsets === null || timescale <= 0) {
		return null
	}

	let loaded: Promise<Mp4Loaded> | null = null

	return async timeSec => {
		loaded ??= (async () => ({
			stts: await tableEntries(source, stts, 8, MAX_TABLE_BYTES),
			stss: stss === null ? null : await tableEntries(source, stss, 4, MAX_TABLE_BYTES),
			stsc: await tableEntries(source, stsc, 12, MAX_TABLE_BYTES)
		}))()

		const tablesRead = await loaded
		const shown = sampleAtTime(tablesRead.stts, Math.max(0, timeSec) * timescale)

		if (shown === 0) {
			return null
		}

		const key = tablesRead.stss === null ? shown : syncSampleAtOrBefore(tablesRead.stss, shown)
		const place = key === null ? null : chunkOfSample(tablesRead.stsc, key)

		if (key === null || place === null) {
			return null
		}

		const offsetBytes = wideOffsets ? 8 : 4
		const offsetAt = chunkOffsets.start + 8 + (place.chunk - 1) * offsetBytes

		if (offsetAt + offsetBytes > chunkOffsets.end) {
			return null
		}

		const offsetField = await readBytes(source, offsetAt, offsetBytes)
		const chunkOffset = wideOffsets ? uint64(offsetField, 0) : uint32(offsetField, 0)
		// sample_size, then sample_count, then the per-sample sizes when sample_size is 0.
		const sizeHeader = await readBytes(source, stsz.start + 4, 8)
		const fixedSize = uint32(sizeHeader, 0)
		let offset = chunkOffset
		let size = fixedSize

		if (offset === null) {
			return null
		}

		if (fixedSize !== 0) {
			offset += (key - place.firstSample) * fixedSize
		} else {
			const sizesAt = stsz.start + 12 + (place.firstSample - 1) * 4
			const sizesLength = (key - place.firstSample + 1) * 4

			if (sizesLength > MAX_CHUNK_SIZE_BYTES || sizesAt + sizesLength > stsz.end) {
				return null
			}

			const sizes = await readBytes(source, sizesAt, sizesLength)

			for (let at = 0; at + 4 < sizes.length; at += 4) {
				offset += uint32(sizes, at)
			}

			size = uint32(sizes, sizes.length - 4)
		}

		if (size === 0 || size > MAX_KEYFRAME_BYTES || offset + size > source.size) {
			return null
		}

		return { offset, size, timeSec: sampleTime(tablesRead.stts, key) / timescale }
	}
}

// ── Fragmented MP4 (mfra) ───────────────────────────────────────────────────

function fragmentedIndex(
	source: BlockSource,
	index: FragmentIndex,
	track: number
): ((timeSec: number) => Promise<KeyframeRef | null>) | null {
	const access = index.access.get(track)
	const timescale = index.timescales.get(track) ?? 0

	if (access === undefined || access.times.length === 0 || timescale <= 0) {
		return null
	}

	const defaults = index.defaults.get(track)

	return async timeSec => {
		const entry = accessAtOrBefore(access, Math.max(0, timeSec) * timescale)
		const moofStart = access.moofs[entry]

		if (moofStart === undefined) {
			return null
		}

		const frame = locateSample(
			await readMoof(source, moofStart),
			moofStart,
			{ track, traf: access.trafs[entry] ?? 0, trun: access.truns[entry] ?? 0, sample: access.samples[entry] ?? 0 },
			defaults
		)

		if (frame === null || frame.size > MAX_KEYFRAME_BYTES || frame.offset + frame.size > source.size) {
			return null
		}

		return { ...frame, timeSec: (access.times[entry] ?? 0) / timescale }
	}
}

// ── Matroska Cues ───────────────────────────────────────────────────────────

// One track's cue points, in file order: time in Matroska ticks, the Cluster's position relative to the
// Segment's data, and the block's position relative to the Cluster's data when the muxer wrote one.
export interface CuePoints {
	times: number[]
	clusters: number[]
	relatives: (number | null)[]
}

export function parseCues(bytes: Uint8Array, track: number): CuePoints {
	const context: EbmlContext = { malformed: false }
	const points: CuePoints = { times: [], clusters: [], relatives: [] }

	// Walked in place, not through ebmlChildren: its child cap would drop the points of a long or short-GOP
	// file past MAX_EBML_CHILDREN, while MAX_CUES_BYTES already bounds this walk.
	for (let at = 0; at < bytes.length;) {
		const point = parseElementHeader(bytes, at)

		if (typeof point === "string" || point.end === null || point.end > bytes.length) {
			break
		}

		at = point.end

		if (point.id !== CUE_POINT_ID) {
			continue
		}

		let time: number | null = null

		for (const field of ebmlChildren(bytes, point.dataStart, point.end, 3, context)) {
			if (field.id === CUE_TIME_ID) {
				time = ebmlUint(bytes, field)
			} else if (field.id === CUE_TRACK_POSITIONS_ID && field.end !== null && time !== null) {
				let cueTrack: number | null = null
				let cluster: number | null = null
				let relative: number | null = null

				for (const position of ebmlChildren(bytes, field.dataStart, field.end, 4, context)) {
					if (position.id === CUE_TRACK_ID) {
						cueTrack = ebmlUint(bytes, position)
					} else if (position.id === CUE_CLUSTER_POSITION_ID) {
						cluster = ebmlUint(bytes, position)
					} else if (position.id === CUE_RELATIVE_POSITION_ID) {
						relative = ebmlUint(bytes, position)
					}
				}

				if (cueTrack === track && cluster !== null) {
					points.times.push(time)
					points.clusters.push(cluster)
					points.relatives.push(relative)
				}
			}
		}
	}

	return points
}

// The last cue at or before `ticks`, or the first when every cue is later; -1 without cues. Cues are
// ordered by time, but a scan keeps an unordered file from sending a binary search astray.
export function cueAtOrBefore(times: readonly number[], ticks: number): number {
	let best = -1
	let first = -1

	for (let i = 0; i < times.length; i++) {
		const time = times[i] ?? 0

		if (first === -1 || time < (times[first] ?? 0)) {
			first = i
		}

		if (time <= ticks && (best === -1 || time >= (times[best] ?? 0))) {
			best = i
		}
	}

	return best === -1 ? first : best
}

// A Block's leading track number (an EBML variable-length integer), timestamp and flags: the frame
// starts after them. Null for another track, or a laced block (several frames in one).
export function blockFrameStart(head: Uint8Array, track: number): { headerLength: number; key: boolean } | null {
	const first = head[0] ?? 0
	let length = 0

	while (length < 8 && (first & (0x80 >> length)) === 0) {
		length++
	}

	length++

	if (length > 8 || head.length < length + 3) {
		return null
	}

	let value = first & (0xff >> length)

	for (let i = 1; i < length; i++) {
		value = value * 256 + (head[i] ?? 0)
	}

	const flags = head[length + 2] ?? 0

	if (value !== track || (flags & 0x06) !== 0) {
		return null
	}

	return { headerLength: length + 3, key: (flags & 0x80) !== 0 }
}

async function elementAt(source: BlockSource, at: number, limit: number): Promise<EbmlElement | null> {
	if (at >= limit) {
		return null
	}

	const element = parseElementHeader(await readBytes(source, at, Math.min(12, limit - at)), 0)

	if (typeof element === "string") {
		return null
	}

	return { id: element.id, start: at, dataStart: at + element.dataStart, end: element.end === null ? null : at + element.end }
}

// The frame a SimpleBlock or a BlockGroup's Block holds, for `track`. `requireKey` skips blocks that are
// not keyframes (a SimpleBlock's flag, a BlockGroup's ReferenceBlock).
async function blockFrame(
	source: BlockSource,
	element: EbmlElement,
	track: number,
	requireKey: boolean
): Promise<{ offset: number; size: number } | null> {
	if (element.end === null || element.end > source.size) {
		return null
	}

	let block: EbmlElement | null = element.id === SIMPLE_BLOCK_ID ? element : null
	let referenced = false

	if (element.id === BLOCK_GROUP_ID) {
		for (let at = element.dataStart, count = 0; at < element.end && count < 8; count++) {
			const child = await elementAt(source, at, element.end)
			const childEnd = child?.end ?? null

			if (child === null || childEnd === null) {
				return null
			}

			if (child.id === BLOCK_ID) {
				block = child
			} else if (child.id === REFERENCE_BLOCK_ID) {
				referenced = true
			}

			at = childEnd
		}
	}

	const blockEnd = block?.end ?? null

	if (block === null || blockEnd === null) {
		return null
	}

	const head = await readBytes(source, block.dataStart, Math.min(11, blockEnd - block.dataStart))
	const frame = blockFrameStart(head, track)
	const isKey = block === element ? frame?.key === true : !referenced

	if (frame === null || (requireKey && !isKey)) {
		return null
	}

	const offset = block.dataStart + frame.headerLength

	return { offset, size: blockEnd - offset }
}

async function clusterKeyframe(
	source: BlockSource,
	cues: CuesLocation,
	cluster: number,
	relative: number | null,
	track: number
): Promise<{ offset: number; size: number } | null> {
	const element = await elementAt(source, cues.segmentStart + cluster, source.size)

	if (element?.id !== CLUSTER_ID) {
		return null
	}

	const end = Math.min(element.end ?? source.size, source.size)

	if (relative !== null) {
		const block = await elementAt(source, element.dataStart + relative, end)

		return block === null ? null : blockFrame(source, block, track, false)
	}

	for (let at = element.dataStart, count = 0; at < end && count < MAX_CLUSTER_CHILDREN; count++) {
		const child = await elementAt(source, at, end)
		const childEnd = child?.end ?? null

		if (child === null || childEnd === null) {
			return null
		}

		if (child.id === SIMPLE_BLOCK_ID || child.id === BLOCK_GROUP_ID) {
			const frame = await blockFrame(source, child, track, true)

			if (frame !== null) {
				return frame
			}
		}

		at = childEnd
	}

	return null
}

function matroskaIndex(source: BlockSource, cues: CuesLocation, track: number): ((timeSec: number) => Promise<KeyframeRef | null>) | null {
	const { at } = cues

	if (at === null || cues.timestampScale <= 0) {
		return null
	}

	let loaded: Promise<CuePoints> | null = null

	return async timeSec => {
		loaded ??= (async () => {
			const element = await elementAt(source, at, source.size)

			if (
				element?.id !== CUES_ID ||
				element.end === null ||
				element.end > source.size ||
				element.end - element.dataStart > MAX_CUES_BYTES
			) {
				throw new MalformedError("no readable Cues")
			}

			return parseCues(await readBytes(source, element.dataStart, element.end - element.dataStart), track)
		})()

		const points = await loaded
		const ticksPerSecond = 1e9 / cues.timestampScale
		const index = cueAtOrBefore(points.times, Math.max(0, timeSec) * ticksPerSecond)
		const cluster = points.clusters[index]

		if (cluster === undefined) {
			return null
		}

		const frame = await clusterKeyframe(source, cues, cluster, points.relatives[index] ?? null, track)

		if (frame === null || frame.size <= 0 || frame.size > MAX_KEYFRAME_BYTES) {
			return null
		}

		return { ...frame, timeSec: (points.times[index] ?? 0) / ticksPerSecond }
	}
}

// ── Entry point ─────────────────────────────────────────────────────────────

function decoderSetup(video: ProbeVideo, decode: VideoDecodeInfo): DecoderSetup | null {
	if (video.codecString === null || video.w <= 0 || video.h <= 0) {
		return null
	}

	return { codec: video.codecString, codedWidth: video.w, codedHeight: video.h, description: decode.description }
}

// The lookup the container's index allows: Matroska Cues, a fragmented MP4's mfra, or the MP4 sample tables
// (empty in a fragmented file, so one without an mfra has nothing to look up).
function keyframeLookup(
	source: BlockSource,
	parsed: ParsedContainer,
	decode: VideoDecodeInfo
): ((timeSec: number) => Promise<KeyframeRef | null>) | null {
	if (parsed.container === "mkv" || parsed.container === "webm") {
		return parsed.cues === undefined ? null : matroskaIndex(source, parsed.cues, decode.track)
	}

	if (parsed.fragments !== undefined) {
		return fragmentedIndex(source, parsed.fragments, decode.track)
	}

	return parsed.index === "none" || decode.tables === null ? null : mp4Index(source, decode.tables)
}

// The picture track's keyframe index, or null when the file has none this can use: no container this
// reads, a fragmented MP4 without an mfra, Matroska without Cues or with encoded frames. The walk reads
// headers the way a card probe does (a fragmented MP4's tail too); the other index bytes are read on the
// first lookup. Failed downloads and an exhausted read budget throw.
export async function openKeyframeIndex(source: BlockSource): Promise<KeyframeIndex | null> {
	const parsed = await walkContainer(source, "card", { keyframes: true })
	const picture = parsed === null ? null : pictureTrack(parsed)
	const decode = picture?.decode

	if (parsed === null || picture === null || decode === undefined || decode.encodedFrames) {
		return null
	}

	const decoder = decoderSetup(picture.video, decode)
	const keyframeAt = keyframeLookup(source, parsed, decode)

	if (decoder === null || keyframeAt === null) {
		return null
	}

	return { durationSec: parsed.durationSec, video: picture.video, decoder, keyframeAt }
}

// One keyframe's bytes.
export function readKeyframe(source: BlockSource, ref: KeyframeRef): Promise<Uint8Array> {
	return readBytes(source, ref.offset, ref.size)
}
