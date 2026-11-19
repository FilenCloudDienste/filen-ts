import {
	assBlockText,
	normalizeCueText,
	type CueTextMode,
	BLOCK_BYTES,
	inflateCapped,
	MAX_SUBTITLE_CUE_CHARS,
	parseElementHeader,
	type EbmlElement
} from "@filen/shared/videos"

// Embedded Matroska text subtitles (S_TEXT/UTF8, S_TEXT/ASS and SSA, S_TEXT/WEBVTT), taken from the cluster bytes
// playback already downloaded: every block the block cache receives passes through here, and the clusters in it
// are walked for the text tracks' blocks. Nothing is ever read for subtitles, so cues exist only for the parts of
// the file playback has read (the playhead and what it buffered ahead); there is no full cue list.

const CLUSTER_ID = 0x1f43b675
const TIMESTAMP_ID = 0xe7
const SIMPLE_BLOCK_ID = 0xa3
const BLOCK_GROUP_ID = 0xa0
const BLOCK_ID = 0xa1
const BLOCK_DURATION_ID = 0x9b

// Top-level elements a cluster walk may meet between clusters, skipped by their size.
const LEVEL_ONE_IDS: ReadonlySet<number> = new Set([
	0x1c53bb6b, // Cues
	0x1254c367, // Tags
	0x1043a770, // Chapters
	0x1941a469, // Attachments
	0x114d9b74, // SeekHead
	0x1549a966, // Info
	0x1654ae6b, // Tracks
	0xec // Void
])

// Blocks kept for a cluster walk that stopped at a block boundary; the cache keeps the bytes anyway.
const WINDOW_BLOCKS = 8
// Walks kept at once (the playhead's, one left behind by a seek).
const MAX_CURSORS = 4
// Element headers read per block arrival at most, BlockGroup children included, so a hostile file can't hold
// the worker.
const MAX_STEPS = 50_000
// A SimpleBlock carries no duration.
export const SIMPLE_BLOCK_CUE_SECONDS = 3
const MAX_CUE_BYTES = 64 * 1024
// Inflated bytes a compressed cue may take: normalizeCueText reads at most 2 * MAX_SUBTITLE_CUE_CHARS
// characters, of at most 4 UTF-8 bytes each. A cue inflating past it is dropped.
const MAX_INFLATED_CUE_BYTES = 8 * MAX_SUBTITLE_CUE_CHARS
// A header-stripping prefix is a few bytes; a track declaring a longer one is not decoded.
const MAX_STRIPPED_HEADER_BYTES = 256
// A BlockGroup carrying a text block is little more than the block; a larger one is skipped by its size.
const MAX_TEXT_GROUP_BYTES = MAX_CUE_BYTES + 4096
const MAX_SEEN = 200_000
// Text tracks decoded at most: the probe offers no more per kind.
const MAX_TAP_TRACKS = 64
// Characters all embedded cues of a file may hold together, each charged its text plus a fixed overhead, so
// tiny cues are counted too. The page keeps the same budget.
export const MAX_EMBEDDED_CUE_CHARS = 16 * 1024 * 1024
const CUE_OVERHEAD_CHARS = 32

export function embeddedCueCharge(text: string): number {
	return text.length + CUE_OVERHEAD_CHARS
}
// A cluster found by searching a block is believed only within this size.
const MAX_FOUND_CLUSTER_BYTES = 1024 * 1024 * 1024

export interface TextTapTrack {
	number: number
	codecId: string
	compression: { algorithm: number; settings: Uint8Array } | "unsupported" | null
}

export interface TextTapCue {
	track: number
	start: number
	end: number
	// Cue payload text (escaped, <i>/<b>/<u> only).
	text: string
	hint: number
}

// A Map, not an object literal: the CodecID comes from the file, and "constructor" or "toString" must not match.
const TEXT_MODES: ReadonlyMap<string, CueTextMode> = new Map<string, CueTextMode>([
	["S_TEXT/UTF8", "srt"],
	["S_TEXT/ASCII", "srt"],
	["S_TEXT/ASS", "ass"],
	["S_TEXT/SSA", "ass"],
	["S_TEXT/WEBVTT", "vtt"]
])

export function isTapTextCodec(codecId: string): boolean {
	return TEXT_MODES.has(codecId)
}

interface Cursor {
	pos: number
	cluster: { end: number; timestamp: number | null } | null
	used: number
}

interface PendingCue {
	track: TextTapTrack
	start: number
	end: number
	frame: Uint8Array
}

type Step = "more" | "stop" | "lost"

// Steps taken in one block arrival's walk, against its budget.
interface Meter {
	steps: number
	budget: number
}

function isDecodable(track: TextTapTrack): boolean {
	const compression = track.compression

	if (compression === "unsupported") {
		return false
	}

	return compression?.algorithm !== 3 || compression.settings.length <= MAX_STRIPPED_HEADER_BYTES
}

export class TextTap {
	private readonly tracks: ReadonlyMap<number, TextTapTrack>
	private readonly scale: number
	private readonly emit: (cues: TextTapCue[]) => void
	private readonly blockBytes: number
	private readonly window = new Map<number, Uint8Array>()
	private readonly cursors: Cursor[] = []
	// Byte offsets of the blocks taken: a block read again is the same block, while two blocks may share a start.
	private readonly seen = new Set<number>()
	private pending: PendingCue[] = []
	private charged = 0
	private readonly charBudget: number
	private decoding = false
	private uses = 0
	private closed = false

	public constructor(params: {
		tracks: readonly TextTapTrack[]
		// Nanoseconds per timestamp tick.
		timestampScale: number
		emit: (cues: TextTapCue[]) => void
		blockBytes?: number
		charBudget?: number
	}) {
		this.tracks = new Map(
			params.tracks
				.filter(track => isTapTextCodec(track.codecId) && isDecodable(track))
				.slice(0, MAX_TAP_TRACKS)
				.map(track => [track.number, track])
		)
		this.scale = params.timestampScale > 0 ? params.timestampScale / 1e9 : 1e-3
		this.emit = params.emit
		this.blockBytes = params.blockBytes ?? BLOCK_BYTES
		this.charBudget = params.charBudget ?? MAX_EMBEDDED_CUE_CHARS
	}

	public get active(): boolean {
		return this.tracks.size > 0 && !this.closed && this.charged < this.charBudget
	}

	// A method rather than a field read: it changes across awaits.
	private isClosed(): boolean {
		return this.closed
	}

	public close(): void {
		this.closed = true
		this.window.clear()
		this.cursors.length = 0
		this.pending = []
	}

	// A block landed in the cache. Never throws: a malformed file only ends the walks over it.
	public addBlock(index: number, bytes: Uint8Array): void {
		if (!this.active) {
			return
		}

		try {
			this.window.delete(index)
			this.window.set(index, bytes)

			while (this.window.size > WINDOW_BLOCKS) {
				const oldest = this.window.keys().next()

				if (oldest.done === true) {
					break
				}

				this.window.delete(oldest.value)
			}

			const start = index * this.blockBytes
			const end = start + bytes.length

			if (!this.cursors.some(cursor => cursor.pos >= start - 16 && cursor.pos < end)) {
				const found = this.findCluster(start, bytes)

				if (found !== null) {
					this.addCursor(found)
				}
			}

			let steps = 0

			for (const cursor of [...this.cursors]) {
				const result = this.advance(cursor, MAX_STEPS - steps)

				steps += result.steps

				if (result.state === "lost") {
					this.dropCursor(cursor)
				}
			}

			this.dropDuplicateCursors()
			this.drain()
		} catch {
			// A walk that throws on hostile bytes just stops; playback is not this module's concern.
		}
	}

	private addCursor(pos: number): void {
		this.cursors.push({ pos, cluster: null, used: ++this.uses })

		while (this.cursors.length > MAX_CURSORS) {
			let oldest: Cursor | undefined

			for (const cursor of this.cursors) {
				if (oldest === undefined || cursor.used < oldest.used) {
					oldest = cursor
				}
			}

			if (oldest === undefined) {
				break
			}

			this.dropCursor(oldest)
		}
	}

	private dropCursor(cursor: Cursor): void {
		const at = this.cursors.indexOf(cursor)

		if (at !== -1) {
			this.cursors.splice(at, 1)
		}
	}

	private dropDuplicateCursors(): void {
		const seen = new Set<number>()

		for (const cursor of [...this.cursors]) {
			if (seen.has(cursor.pos)) {
				this.dropCursor(cursor)
			} else {
				seen.add(cursor.pos)
			}
		}
	}

	// `length` bytes at `pos` when every block they lie in is in the window; null otherwise.
	private bytesAt(pos: number, length: number): Uint8Array | null {
		const first = Math.floor(pos / this.blockBytes)
		const last = Math.floor((pos + Math.max(length, 1) - 1) / this.blockBytes)
		const head = this.window.get(first)

		if (head === undefined) {
			return null
		}

		const offset = pos - first * this.blockBytes

		if (first === last) {
			return offset + length <= head.length ? head.subarray(offset, offset + length) : null
		}

		const out = new Uint8Array(length)
		let written = 0

		for (let index = first; index <= last; index++) {
			const block = this.window.get(index)

			if (block === undefined) {
				return null
			}

			const from = index === first ? offset : 0
			const take = Math.min(block.length - from, length - written)

			out.set(block.subarray(from, from + take), written)
			written += take
		}

		return written === length ? out : null
	}

	// The element header at `pos`: null when its bytes aren't here yet, "invalid" when none can start there.
	private header(pos: number): EbmlElement | "invalid" | null {
		for (const length of [12, 8, 4, 2]) {
			const bytes = this.bytesAt(pos, length)

			if (bytes === null) {
				continue
			}

			const parsed = parseElementHeader(bytes, 0)

			if (parsed === "invalid") {
				return "invalid"
			}

			if (parsed === "short") {
				return null
			}

			return {
				id: parsed.id,
				start: pos,
				dataStart: pos + parsed.dataStart,
				end: parsed.end === null ? null : pos + parsed.end
			}
		}

		return null
	}

	// A cluster's start within a freshly landed block nobody walks yet (playback jumped here): its ID followed by a
	// plausible size and a Timestamp as its first child.
	private findCluster(start: number, bytes: Uint8Array): number | null {
		for (let i = bytes.indexOf(0x1f); i !== -1 && i + 4 < bytes.length; i = bytes.indexOf(0x1f, i + 1)) {
			if (bytes[i + 1] !== 0x43 || bytes[i + 2] !== 0xb6 || bytes[i + 3] !== 0x75) {
				continue
			}

			const header = this.header(start + i)

			if (header === null || header === "invalid" || header.id !== CLUSTER_ID) {
				continue
			}

			if (header.end !== null && header.end - header.dataStart > MAX_FOUND_CLUSTER_BYTES) {
				continue
			}

			const child = this.header(header.dataStart)

			if (child !== null && child !== "invalid" && child.id === TIMESTAMP_ID) {
				return start + i
			}
		}

		return null
	}

	private advance(cursor: Cursor, budget: number): { state: Step; steps: number } {
		const meter: Meter = { steps: 0, budget }

		while (meter.steps < meter.budget) {
			meter.steps++

			const cluster = cursor.cluster

			if (cluster !== null && cursor.pos >= cluster.end) {
				cursor.cluster = null

				continue
			}

			const header = this.header(cursor.pos)

			if (header === null) {
				return { state: "stop", steps: meter.steps }
			}

			if (header === "invalid") {
				return { state: "lost", steps: meter.steps }
			}

			if (header.id === CLUSTER_ID) {
				// A cluster of unknown size ends where the next one starts.
				cursor.cluster = { end: header.end ?? Number.POSITIVE_INFINITY, timestamp: null }
				cursor.pos = header.dataStart
				cursor.used = ++this.uses

				continue
			}

			if (cluster === null) {
				if (!LEVEL_ONE_IDS.has(header.id) || header.end === null) {
					return { state: "lost", steps: meter.steps }
				}

				cursor.pos = header.end

				continue
			}

			if (header.end === null) {
				return { state: "lost", steps: meter.steps }
			}

			const state = this.clusterChild(
				cluster,
				{ id: header.id, start: header.start, dataStart: header.dataStart, end: header.end },
				meter
			)

			if (state !== "more") {
				return { state, steps: meter.steps }
			}

			cursor.pos = header.end
			cursor.used = ++this.uses
		}

		return { state: "stop", steps: meter.steps }
	}

	private clusterChild(cluster: NonNullable<Cursor["cluster"]>, element: EbmlElement & { end: number }, meter: Meter): Step {
		const size = element.end - element.dataStart

		switch (element.id) {
			case TIMESTAMP_ID: {
				const value = size > 0 && size <= 8 ? this.bytesAt(element.dataStart, size) : null

				if (value === null) {
					return size > 0 && size <= 8 ? "stop" : "lost"
				}

				let timestamp = 0

				for (const byte of value) {
					timestamp = timestamp * 256 + byte
				}

				cluster.timestamp = timestamp

				return "more"
			}
			case SIMPLE_BLOCK_ID:
				return this.block(cluster, element.dataStart, element.end, null)
			case BLOCK_GROUP_ID:
				return size > MAX_TEXT_GROUP_BYTES ? "more" : this.group(cluster, element, meter)
			default:
				return "more"
		}
	}

	// Walked from its start again on the next arrival when it stops, so it is cut off by `meter` like the rest.
	private group(cluster: NonNullable<Cursor["cluster"]>, group: EbmlElement & { end: number }, meter: Meter): Step {
		let block: { start: number; end: number } | null = null
		let duration: number | null = null

		for (let pos = group.dataStart; pos < group.end;) {
			if (meter.steps >= meter.budget) {
				return "stop"
			}

			meter.steps++

			const child = this.header(pos)

			if (child === null) {
				return "stop"
			}

			if (child === "invalid" || child.end === null || child.end > group.end) {
				return "lost"
			}

			if (child.id === BLOCK_ID) {
				block = { start: child.dataStart, end: child.end }
			} else if (child.id === BLOCK_DURATION_ID) {
				const size = child.end - child.dataStart
				const value = size > 0 && size <= 8 ? this.bytesAt(child.dataStart, size) : null

				if (value === null) {
					return "stop"
				}

				duration = 0

				for (const byte of value) {
					duration = duration * 256 + byte
				}
			}

			pos = child.end
		}

		return block === null ? "more" : this.block(cluster, block.start, block.end, duration)
	}

	// A Block or SimpleBlock: track number (EBML vint), int16 relative timestamp, flags, then the frame.
	private block(cluster: NonNullable<Cursor["cluster"]>, start: number, end: number, duration: number | null): Step {
		const head = this.bytesAt(start, Math.min(end - start, 12))

		if (head === null) {
			return "stop"
		}

		const first = head[0] ?? 0
		let length = 0

		while (length < 8 && (first & (0x80 >> length)) === 0) {
			length++
		}

		length++

		if (length > 8 || head.length < length + 3) {
			return "more"
		}

		let number = first & (0xff >> length)

		for (let i = 1; i < length; i++) {
			number = number * 256 + (head[i] ?? 0)
		}

		const track = this.tracks.get(number)

		if (track === undefined || cluster.timestamp === null) {
			return "more"
		}

		const relative = (((head[length] ?? 0) << 24) >> 16) | (head[length + 1] ?? 0)
		const flags = head[length + 2] ?? 0
		const frameStart = start + length + 3
		const frameLength = end - frameStart

		// Laced subtitle blocks don't occur in practice; one is skipped rather than misread.
		if ((flags & 0x06) !== 0 || frameLength <= 0 || frameLength > MAX_CUE_BYTES) {
			return "more"
		}

		const frame = this.bytesAt(frameStart, frameLength)

		if (frame === null) {
			return "stop"
		}

		const startSeconds = (cluster.timestamp + relative) * this.scale
		const endSeconds = duration === null ? startSeconds + SIMPLE_BLOCK_CUE_SECONDS : startSeconds + duration * this.scale

		if (!this.seen.has(start) && this.seen.size < MAX_SEEN && startSeconds >= 0) {
			this.seen.add(start)
			this.pending.push({ track, start: startSeconds, end: Math.max(startSeconds, endSeconds), frame: frame.slice() })
		}

		return "more"
	}

	// Decodes what was found (inflating where the track is compressed) one cue at a time, so at most one
	// inflate is held at once, and hands on each batch of what was found meanwhile at once.
	private drain(): void {
		if (this.decoding || this.pending.length === 0) {
			return
		}

		this.decoding = true
		void this.decodePending().catch(() => undefined)
	}

	private async decodePending(): Promise<void> {
		try {
			while (this.pending.length > 0 && !this.isClosed()) {
				const batch = this.pending
				const out: TextTapCue[] = []

				this.pending = []

				for (const cue of batch) {
					if (this.isClosed()) {
						return
					}

					const decoded = await this.decode(cue)

					if (decoded !== null) {
						this.charged += embeddedCueCharge(decoded.text)

						if (this.charged > this.charBudget) {
							// Over budget: nothing more is walked, queued or handed on.
							this.pending = []

							break
						}

						out.push(decoded)
					}
				}

				if (out.length > 0 && !this.isClosed()) {
					this.emit(out)
				}
			}
		} finally {
			this.decoding = false
		}
	}

	private async decode(cue: PendingCue): Promise<TextTapCue | null> {
		const compression = cue.track.compression
		let bytes: Uint8Array | null = cue.frame

		if (compression !== null && compression !== "unsupported") {
			if (compression.algorithm === 3) {
				const joined = new Uint8Array(compression.settings.length + bytes.length)

				joined.set(compression.settings)
				joined.set(bytes, compression.settings.length)
				bytes = joined
			} else {
				bytes = await inflateCapped(bytes, MAX_INFLATED_CUE_BYTES)
			}
		}

		if (bytes === null) {
			return null
		}

		const mode = TEXT_MODES.get(cue.track.codecId) ?? "srt"
		const raw = new TextDecoder().decode(bytes)
		const normalized = normalizeCueText(mode === "ass" ? assBlockText(raw) : raw, mode)

		return normalized.text.length === 0 || normalized.drawing
			? null
			: { track: cue.track.number, start: cue.start, end: cue.end, text: normalized.text, hint: normalized.hint }
	}
}
