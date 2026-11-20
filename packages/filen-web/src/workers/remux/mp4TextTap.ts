import { BLOCK_BYTES, normalizeCueText, uint32, uint64, type SampleTables } from "@filen/shared/videos"
import { BlockAbortError } from "@/lib/media/blockCache"
import { MAX_EMBEDDED_CUE_CHARS, embeddedCueCharge, type TextTapCue } from "@/workers/remux/textTap"

// Embedded MP4 text subtitles (3GPP timed text: tx3g and QuickTime text; WebVTT in MP4: wvtt). The moov's sample
// tables say where every sample lies and when it shows, so cues are read only around what playback reads: each
// block the cache receives is searched for the samples inside it (an interleaved file, the usual layout, costs no
// read), and samples playback has passed without their bytes landing (text kept apart from the media) are read
// directly, a stretch at a time. A fragmented MP4 keeps its samples in moofs, which this does not read.

// Samples indexed per track: a feature film's track holds a few thousand (cues and the gaps between them).
export const MAX_TEXT_SAMPLES = 65_536
// Text tracks decoded at most.
const MAX_TEXT_TRACKS = 32
// stts and stsc are read whole; past this a text track is not indexed.
const MAX_TABLE_BYTES = 1_048_576
// A text sample larger than this is not a cue.
const MAX_SAMPLE_BYTES = 64 * 1024
// How far behind the read position a sample's bytes may still land with playback's own reads before they are read
// for the subtitles alone.
export const DIRECT_READ_LAG_SECONDS = 5
// How far past the read position a direct read takes the samples along, so text stored apart costs one read per stretch.
export const DIRECT_READ_AHEAD_SECONDS = 300
// Bytes one direct read spans at most; a sample further away waits for the next read.
export const MAX_DIRECT_READ_BYTES = BLOCK_BYTES
// tx3g style records looked at per sample.
const MAX_STYLE_RECORDS = 64
// Sample bytes decoded for one block or one direct read, as a multiple of the bytes it spans: a file's own samples lie
// apart, so they never come near it, while samples declared over the same bytes are given up past it.
const DECODE_SPAN_FACTOR = 2

const TEXT_CODECS: ReadonlySet<string> = new Set(["tx3g", "text", "wvtt"])

export function isMp4TextCodec(codecId: string): boolean {
	return TEXT_CODECS.has(codecId)
}

// Every sample of a text track: file offset, size, and when it shows, in time order.
export interface Mp4TextSamples {
	offsets: Float64Array
	sizes: Uint32Array
	starts: Float64Array
	ends: Float64Array
}

export interface Mp4TextTrack {
	number: number
	codecId: string
	samples: Mp4TextSamples
}

type ReadBytes = (start: number, end: number) => Promise<Uint8Array>

// A full box's version/flags and entry count, then its entries, read whole under `cap` (entries past the box are
// not believed).
async function entries(
	read: ReadBytes,
	range: { start: number; end: number },
	entryBytes: number,
	cap: number
): Promise<Uint8Array | null> {
	if (range.end - range.start < 8) {
		return null
	}

	const count = uint32(await read(range.start + 4, range.start + 8), 0)
	const length = Math.min(count * entryBytes, range.end - range.start - 8)

	if (length > cap) {
		return null
	}

	return read(range.start + 8, range.start + 8 + length - (length % entryBytes))
}

// The samples of a text track from its sample tables; null when a table is missing, malformed or past the caps.
export async function readMp4TextSamples(tables: SampleTables, read: ReadBytes): Promise<Mp4TextSamples | null> {
	const { stts, stsc, stsz, chunkOffsets, timescale, wideOffsets } = tables

	if (stts === null || stsc === null || stsz === null || chunkOffsets === null || timescale <= 0 || stsz.end - stsz.start < 12) {
		return null
	}

	const sizeHead = await read(stsz.start + 4, stsz.start + 12)
	const fixedSize = uint32(sizeHead, 0)
	let count = Math.min(uint32(sizeHead, 4), MAX_TEXT_SAMPLES)

	if (count === 0) {
		return null
	}

	const times = await entries(read, stts, 8, MAX_TABLE_BYTES)
	const runs = await entries(read, stsc, 12, MAX_TABLE_BYTES)
	const offsetBytes = wideOffsets ? 8 : 4
	const chunks = await entries(read, chunkOffsets, offsetBytes, MAX_TEXT_SAMPLES * offsetBytes)

	if (times === null || runs === null || chunks === null) {
		return null
	}

	const sizes = new Uint32Array(count)

	if (fixedSize !== 0) {
		sizes.fill(fixedSize)
	} else {
		if (stsz.start + 12 + count * 4 > stsz.end) {
			return null
		}

		const listed = await read(stsz.start + 12, stsz.start + 12 + count * 4)

		for (let index = 0; index < count; index++) {
			sizes[index] = uint32(listed, index * 4)
		}
	}

	const starts = new Float64Array(count)
	const ends = new Float64Array(count)
	let sample = 0
	let ticks = 0

	for (let at = 0; at + 8 <= times.length && sample < count; at += 8) {
		const run = uint32(times, at)
		const delta = uint32(times, at + 4)

		for (let index = 0; index < run && sample < count; index++) {
			starts[sample] = ticks / timescale
			ends[sample] = (ticks + delta) / timescale
			ticks += delta
			sample++
		}
	}

	count = sample

	const offsets = new Float64Array(count)
	const chunkCount = Math.floor(chunks.length / offsetBytes)

	sample = 0

	for (let at = 0; at + 12 <= runs.length && sample < count; at += 12) {
		const firstChunk = uint32(runs, at)
		const perChunk = uint32(runs, at + 4)
		const nextChunk = at + 24 <= runs.length ? uint32(runs, at + 12) : chunkCount + 1

		if (firstChunk === 0 || nextChunk <= firstChunk) {
			return null
		}

		for (let chunk = firstChunk; chunk < nextChunk && chunk <= chunkCount && sample < count; chunk++) {
			let offset = wideOffsets ? uint64(chunks, (chunk - 1) * 8) : uint32(chunks, (chunk - 1) * 4)

			if (offset === null) {
				return null
			}

			for (let index = 0; index < perChunk && sample < count; index++) {
				offsets[sample] = offset
				offset += sizes[sample] ?? 0
				sample++
			}
		}
	}

	// The sample-to-chunk table may cover fewer samples than the time table: the ones it leaves out have no place.
	return {
		offsets: offsets.subarray(0, sample),
		sizes: sizes.subarray(0, sample),
		starts: starts.subarray(0, sample),
		ends: ends.subarray(0, sample)
	}
}

const utf8 = new TextDecoder()

function escapeText(char: string): string {
	return char === "&" ? "&amp;" : char === "<" ? "&lt;" : char
}

// A 3GPP timed text sample: a 16-bit length, the text (UTF-8, or UTF-16 after a byte order mark), then modifier
// boxes, of which `styl` turns bold, italic and underline on per character range. The text comes out escaped with
// <b>/<i>/<u>, as cue normalization reads it; null for an empty sample (the gap between two cues).
export function tx3gCueText(sample: Uint8Array): string | null {
	if (sample.length < 2) {
		return null
	}

	const length = ((sample[0] ?? 0) << 8) | (sample[1] ?? 0)

	if (length === 0 || 2 + length > sample.length) {
		return null
	}

	const body = sample.subarray(2, 2 + length)
	const text = body[0] === 0xfe && body[1] === 0xff ? new TextDecoder("utf-16be").decode(body.subarray(2)) : utf8.decode(body)
	const chars = Array.from(text)
	const opens = new Map<number, string>()
	const closes = new Map<number, string>()
	let covered = 0

	for (let at = 2 + length; at + 8 <= sample.length;) {
		const size = uint32(sample, at)
		const end = at + size

		if (size < 8 || end > sample.length) {
			break
		}

		if (sample[at + 4] === 0x73 && sample[at + 5] === 0x74 && sample[at + 6] === 0x79 && sample[at + 7] === 0x6c && at + 10 <= end) {
			const records = Math.min(((sample[at + 8] ?? 0) << 8) | (sample[at + 9] ?? 0), MAX_STYLE_RECORDS)

			for (let record = 0; record < records && at + 10 + (record + 1) * 12 <= end; record++) {
				const base = at + 10 + record * 12
				const first = ((sample[base] ?? 0) << 8) | (sample[base + 1] ?? 0)
				const last = Math.min(((sample[base + 2] ?? 0) << 8) | (sample[base + 3] ?? 0), chars.length)
				const flags = sample[base + 6] ?? 0
				const tags = [flags & 1 ? "b" : "", flags & 2 ? "i" : "", flags & 4 ? "u" : ""].filter(tag => tag.length > 0)

				// Records are ordered and apart; one that overlaps the last is left out rather than nested wrongly.
				if (tags.length === 0 || first < covered || first >= last) {
					continue
				}

				opens.set(first, (opens.get(first) ?? "") + tags.map(tag => `<${tag}>`).join(""))
				closes.set(
					last,
					tags
						.reverse()
						.map(tag => `</${tag}>`)
						.join("") + (closes.get(last) ?? "")
				)
				covered = last
			}
		}

		at = end
	}

	let out = ""

	for (let index = 0; index <= chars.length; index++) {
		out += (closes.get(index) ?? "") + (opens.get(index) ?? "") + escapeText(chars[index] ?? "")
	}

	return out
}

// A WebVTT-in-MP4 sample: `vttc` boxes, each holding its cue text in `payl` (`vtte` marks a gap). One sample may
// show several cues at once.
export function wvttCueTexts(sample: Uint8Array): string[] {
	const texts: string[] = []

	for (let at = 0; at + 8 <= sample.length;) {
		const size = uint32(sample, at)
		const end = at + size

		if (size < 8 || end > sample.length) {
			break
		}

		if (sample[at + 4] === 0x76 && sample[at + 5] === 0x74 && sample[at + 6] === 0x74 && sample[at + 7] === 0x63) {
			for (let child = at + 8; child + 8 <= end;) {
				const childSize = uint32(sample, child)

				if (childSize < 8 || child + childSize > end) {
					break
				}

				if (sample[child + 4] === 0x70 && sample[child + 5] === 0x61 && sample[child + 6] === 0x79 && sample[child + 7] === 0x6c) {
					texts.push(utf8.decode(sample.subarray(child + 8, child + childSize)))
				}

				child += childSize
			}
		}

		at = end
	}

	return texts
}

interface TrackState {
	track: Mp4TextTrack
	// Sample indexes in file order, for finding the samples inside a block.
	byOffset: Uint32Array
	// 1 once a sample was taken (decoded or found empty).
	taken: Uint8Array
	// The first sample in time order not known to be taken since the last seek.
	cursor: number
}

// The first index in `byOffset` whose sample starts at or after `offset`.
function firstAtOrAfter(state: TrackState, offset: number): number {
	let low = 0
	let high = state.byOffset.length

	while (low < high) {
		const mid = (low + high) >>> 1

		if ((state.track.samples.offsets[state.byOffset[mid] ?? 0] ?? 0) < offset) {
			low = mid + 1
		} else {
			high = mid
		}
	}

	return low
}

// The last sample in time order starting at or before `time`, 0 when none does.
function sampleAt(samples: Mp4TextSamples, time: number): number {
	let low = 0
	let high = samples.starts.length - 1
	let found = 0

	while (low <= high) {
		const mid = (low + high) >>> 1

		if ((samples.starts[mid] ?? 0) <= time) {
			found = mid
			low = mid + 1
		} else {
			high = mid - 1
		}
	}

	return found
}

export class Mp4TextTap {
	private readonly states: TrackState[]
	private readonly peek: (start: number, end: number) => Uint8Array | null
	private readonly readDirect: ReadBytes
	private readonly emit: (cues: TextTapCue[]) => void
	private readonly blockBytes: number
	private readonly charBudget: number
	private charged = 0
	private readUntil = 0
	private reading = false
	private closed = false

	public constructor(params: {
		tracks: readonly Mp4TextTrack[]
		// Bytes already held, never a download (the block cache's peek).
		peek: (start: number, end: number) => Uint8Array | null
		// Bytes read for the subtitles alone, past the cache.
		readDirect: ReadBytes
		emit: (cues: TextTapCue[]) => void
		blockBytes?: number
		charBudget?: number
	}) {
		this.states = params.tracks
			.filter(track => isMp4TextCodec(track.codecId) && track.samples.starts.length > 0)
			.slice(0, MAX_TEXT_TRACKS)
			.map(track => {
				const offsets = track.samples.offsets
				const byOffset = Uint32Array.from({ length: offsets.length }, (_, index) => index).sort(
					(a, b) => (offsets[a] ?? 0) - (offsets[b] ?? 0)
				)

				return { track, byOffset, taken: new Uint8Array(offsets.length), cursor: 0 }
			})
		this.peek = params.peek
		this.readDirect = params.readDirect
		this.emit = params.emit
		this.blockBytes = params.blockBytes ?? BLOCK_BYTES
		this.charBudget = params.charBudget ?? MAX_EMBEDDED_CUE_CHARS
	}

	public get active(): boolean {
		return this.states.length > 0 && !this.closed && this.charged < this.charBudget
	}

	// A method rather than a field read: it changes across awaits.
	private isClosed(): boolean {
		return this.closed
	}

	public close(): void {
		this.closed = true
	}

	// Playback restarts at `time`: samples before it are not read for having been passed.
	public seek(time: number): void {
		for (const state of this.states) {
			state.cursor = sampleAt(state.track.samples, time)
		}

		this.readUntil = time
	}

	// A block landed in the cache: the samples inside it (or ending in it) are taken from what is held. Never throws
	// (it runs inside the cache's store, which playback waits on): a malformed file only ends the tap.
	public addBlock(index: number, bytes: Uint8Array): void {
		if (!this.active) {
			return
		}

		const cues: TextTapCue[] = []

		try {
			this.takeHeld(index * this.blockBytes, index * this.blockBytes + bytes.length, cues)
		} catch {
			// Hostile tables that slip past the checks end the tap, never the block read playback waits on.
			this.close()

			return
		}

		this.hand(cues)
	}

	private takeHeld(blockStart: number, blockEnd: number, cues: TextTapCue[]): void {
		const from = Math.max(0, blockStart - MAX_SAMPLE_BYTES)
		let allowance = (blockEnd - from) * DECODE_SPAN_FACTOR

		for (const state of this.states) {
			const { offsets, sizes } = state.track.samples

			for (let at = firstAtOrAfter(state, from); at < state.byOffset.length; at++) {
				if (!this.active) {
					return
				}

				const sample = state.byOffset[at] ?? 0
				const offset = offsets[sample] ?? 0
				const size = sizes[sample] ?? 0

				if (offset >= blockEnd) {
					break
				}

				if (state.taken[sample] === 1 || offset + size > blockEnd) {
					continue
				}

				// An empty sample (legal, a gap) holds no cue and has no bytes to peek; one past the block's allowance
				// overlaps others (a crafted file) and is given up.
				if (size === 0 || size > MAX_SAMPLE_BYTES || size > allowance) {
					state.taken[sample] = 1

					continue
				}

				const held = this.peek(offset, offset + size)

				if (held !== null) {
					allowance -= size
					this.take(state, sample, held, cues)
				}
			}
		}
	}

	// The media pumps have read up to `time`: samples they passed whose bytes never landed are read directly.
	public advance(time: number): void {
		if (!Number.isFinite(time)) {
			return
		}

		this.readUntil = Math.max(this.readUntil, time)

		if (this.reading || !this.active) {
			return
		}

		const due = this.readUntil - DIRECT_READ_LAG_SECONDS

		for (const state of this.states) {
			const { starts, offsets, sizes } = state.track.samples

			while (
				state.cursor < starts.length &&
				(state.taken[state.cursor] === 1 || (sizes[state.cursor] ?? 0) === 0 || (sizes[state.cursor] ?? 0) > MAX_SAMPLE_BYTES)
			) {
				state.taken[state.cursor] = 1
				state.cursor++
			}

			const first = state.cursor

			if (first >= starts.length || (starts[first] ?? 0) > due) {
				continue
			}

			const from = offsets[first] ?? 0
			let to = from + (sizes[first] ?? 0)
			const picked: number[] = []

			for (
				let sample = first;
				sample < starts.length && (starts[sample] ?? 0) <= this.readUntil + DIRECT_READ_AHEAD_SECONDS;
				sample++
			) {
				const offset = offsets[sample] ?? 0
				const end = offset + (sizes[sample] ?? 0)

				if (state.taken[sample] === 1) {
					continue
				}

				if (offset < from || end - from > MAX_DIRECT_READ_BYTES) {
					break
				}

				picked.push(sample)
				to = Math.max(to, end)
			}

			this.reading = true
			void this.readStretch(state, picked, from, to)

			return
		}
	}

	private async readStretch(state: TrackState, picked: readonly number[], from: number, to: number): Promise<void> {
		const cues: TextTapCue[] = []

		try {
			const bytes = await this.readDirect(from, to)

			if (this.isClosed()) {
				return
			}

			const { offsets, sizes } = state.track.samples
			let allowance = (to - from) * DECODE_SPAN_FACTOR

			for (const sample of picked) {
				if (!this.active) {
					break
				}

				const offset = (offsets[sample] ?? 0) - from
				const size = sizes[sample] ?? 0

				if (size <= MAX_SAMPLE_BYTES && size <= allowance && offset + size <= bytes.length) {
					allowance -= size
					this.take(state, sample, bytes.subarray(offset, offset + size), cues)
				} else {
					state.taken[sample] = 1
				}
			}
		} catch (error) {
			// A read called off by a seek leaves its samples to be read again; a failed one gives them up, so a broken
			// source is not asked again at every packet.
			if (!(error instanceof BlockAbortError)) {
				for (const sample of picked) {
					state.taken[sample] = 1
				}
			}
		} finally {
			this.reading = false
		}

		this.hand(cues)

		if (cues.length > 0) {
			this.advance(this.readUntil)
		}
	}

	private take(state: TrackState, sample: number, bytes: Uint8Array, out: TextTapCue[]): void {
		state.taken[sample] = 1

		const { starts, ends } = state.track.samples
		const start = starts[sample] ?? 0
		const end = Math.max(start, ends[sample] ?? start)
		const wvtt = state.track.codecId === "wvtt"
		const raws = wvtt ? wvttCueTexts(bytes) : [tx3gCueText(bytes)]

		for (const raw of raws) {
			if (raw === null) {
				continue
			}

			const normalized = normalizeCueText(raw, wvtt ? "vtt" : "srt")

			if (normalized.text.length === 0) {
				continue
			}

			this.charged += embeddedCueCharge(normalized.text)

			if (this.charged > this.charBudget) {
				return
			}

			out.push({ track: state.track.number, start, end, text: normalized.text, hint: normalized.hint })
		}
	}

	private hand(cues: TextTapCue[]): void {
		if (cues.length > 0 && !this.closed) {
			this.emit(cues)
		}
	}
}
