import {
	EncodedPacket,
	type AudioCodec,
	type Demuxer,
	type Input,
	type InputAudioTrackBacking,
	type InputTrackBacking,
	type InputVideoTrackBacking,
	type MetadataTags,
	type PacketRetrievalOptions,
	type TrackDisposition,
	type VideoCodec
} from "mediabunny"

// The demuxers for containers mediabunny does not read (FLV, AVI, ASF, MPEG program streams). Each format supplies
// a ContainerReader: its tracks, the packets in a stretch of the file, and where a time is; this turns that into
// mediabunny's track backings. Packets are kept in runs (stretches read contiguously from some position), since a
// seek far into a file without a complete index starts reading there rather than from the start.

// One packet as a reader found it. `unit` is where the container unit holding its start begins (a tag, a chunk, a
// pack, a data packet): a reader can start reading there again. `part` tells packets starting in one unit apart
// (below MAX_PARTS). Its bytes are the `size` bytes at `pos`, or `payload` when the reader assembled them itself (an
// ASF object from fragments, a PES payload).
export interface DemuxPacket {
	track: number
	// Presentation time, seconds, on the file's own clock.
	pts: number
	duration: number
	key: boolean
	unit: number
	part: number
	pos: number
	size: number
	payload?: Uint8Array
}

export const MAX_PARTS = 64

// A packet's identity, which also orders packets in decode order and gives back its unit.
function sequenceOf(packet: DemuxPacket): number {
	return packet.unit * MAX_PARTS + packet.part
}

interface TrackCommon {
	number: number
	name: string | null
	language: string
	isDefault: boolean
	// The container's own codec identifier (a FourCC, a format tag).
	internalCodecId: string | number | null
}

export interface DemuxVideoTrack extends TrackCommon {
	type: "video"
	codec: VideoCodec | null
	width: number
	height: number
	// The picture's size with square pixels.
	squarePixelWidth: number
	squarePixelHeight: number
	decoderConfig: VideoDecoderConfig | null
}

export interface DemuxAudioTrack extends TrackCommon {
	type: "audio"
	codec: AudioCodec | null
	channels: number
	sampleRate: number
	decoderConfig: AudioDecoderConfig | null
}

export type DemuxTrack = DemuxVideoTrack | DemuxAudioTrack

export interface ContainerReader {
	readonly tracks: readonly DemuxTrack[]
	// Seconds, or null where the header does not say.
	readonly duration: number | null
	// Where the first packet's data starts.
	readonly dataStart: number
	// The packets whose units start at or after `pos` (a clean unit boundary), in file order, and where the next read
	// starts; null at the end of the data.
	readPackets(pos: number): Promise<{ packets: DemuxPacket[]; next: number } | null>
	// The first clean unit boundary at or after `pos`; null when none follows.
	resync(pos: number): Promise<number | null>
	// A unit boundary at or before time `t` from the file's own index; null where it has none.
	indexedPosition?(t: number): Promise<number | null>
}

// Bytes at `start` through the input's reader (the block cache under it); null past the file's end.
export async function readAt(input: Input, start: number, length: number): Promise<Uint8Array | null> {
	const slice = await input._reader.requestSlice(start, length)

	return slice === null ? null : slice.bytes.subarray(slice.bufferPos, slice.bufferPos + length)
}

// A run is read until the track has a packet this far past a target, so a picture reordered behind a later one is in.
const REORDER_MARGIN_SECONDS = 1
// Below this many bytes from a known point to the target, read forward rather than jump.
const READ_FORWARD_BYTES = 4 * 1024 * 1024
// How far before an interpolated position a jump lands.
const SEEK_BACKOFF_BYTES = 128 * 1024
// Jumps one search makes before it reads forward from the best point it has.
const MAX_JUMPS = 12
// Packets kept across runs; past it the runs used least recently are dropped (read again if wanted).
const MAX_KEPT_PACKETS = 250_000
// How far before a target the key search first looks, doubled while no key is found.
const KEY_BACKOFF_SECONDS = 2

interface Run {
	start: number
	next: number
	done: boolean
	packets: DemuxPacket[]
	used: number
}

const NO_DATA = new Uint8Array(0)

function lastSequence(run: { packets: DemuxPacket[] }): number {
	const last = run.packets.at(-1)

	return last === undefined ? -1 : sequenceOf(last)
}

class Mutex {
	private tail: Promise<void> = Promise.resolve()

	public async run<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail
		const { promise, resolve } = Promise.withResolvers<undefined>()

		this.tail = promise
		await previous

		try {
			return await task()
		} finally {
			resolve(undefined)
		}
	}
}

export class PacketDemuxer implements Demuxer {
	public readonly input: Input
	private readonly open: Promise<ContainerReader>
	private readonly mimeType: string
	private readonly runs: Run[] = []
	private readonly mutex = new Mutex()
	private clock = 0
	private offset: number | null = null

	public constructor(input: Input, mimeType: string, open: (input: Input) => Promise<ContainerReader>) {
		this.input = input
		this.mimeType = mimeType
		this.open = open(input)
	}

	public dispose(): void {
		this.runs.length = 0
	}

	public async getMimeType(): Promise<string> {
		return Promise.resolve(this.mimeType)
	}

	public async getMetadataTags(): Promise<MetadataTags> {
		return Promise.resolve({})
	}

	public async getTrackBackings(): Promise<InputTrackBacking[]> {
		const reader = await this.open

		return reader.tracks.map(track => (track.type === "video" ? new VideoBacking(this, track) : new AudioBacking(this, track)))
	}

	public async duration(): Promise<number | null> {
		return (await this.open).duration
	}

	// The file clock's time of the first packet, which the exposed timestamps count from.
	private async timeOffset(reader: ContainerReader): Promise<number> {
		if (this.offset !== null) {
			return this.offset
		}

		const first = this.runAt(reader.dataStart)

		while (first.packets.length === 0 && !first.done) {
			await this.advance(reader, first)
		}

		this.offset = first.packets.reduce((least, packet) => Math.min(least, packet.pts), Infinity)

		if (!Number.isFinite(this.offset)) {
			this.offset = 0
		}

		return this.offset
	}

	private runAt(start: number): Run {
		const existing = this.runs.find(run => run.start <= start && start < Math.max(run.next, run.start + 1))

		if (existing !== undefined) {
			return existing
		}

		const run: Run = { start, next: start, done: false, packets: [], used: this.clock }

		this.runs.push(run)
		this.runs.sort((a, b) => a.start - b.start)

		return run
	}

	private async advance(reader: ContainerReader, run: Run): Promise<void> {
		run.used = ++this.clock

		const read = run.done ? null : await reader.readPackets(run.next)

		if (read === null || read.next <= run.next) {
			run.done = true

			return
		}

		const last = lastSequence(run)

		for (const packet of read.packets) {
			if (sequenceOf(packet) > last) {
				run.packets.push(packet)
			}
		}

		run.next = read.next
		this.mergeFollowing(run)
		this.evict(run)
	}

	// A run that reached where a later one starts takes that one over.
	private mergeFollowing(run: Run): void {
		for (const other of this.runs) {
			if (other === run || other.start < run.start || other.start > run.next) {
				continue
			}

			const last = lastSequence(run)

			for (const packet of other.packets) {
				if (sequenceOf(packet) > last) {
					run.packets.push(packet)
				}
			}

			if (other.next > run.next) {
				run.next = other.next
				run.done = other.done
			}

			this.runs.splice(this.runs.indexOf(other), 1)
			this.mergeFollowing(run)

			return
		}
	}

	private evict(keep: Run): void {
		let total = this.runs.reduce((sum, run) => sum + run.packets.length, 0)

		while (total > MAX_KEPT_PACKETS) {
			const oldest = this.runs.filter(run => run !== keep).sort((a, b) => a.used - b.used)[0]

			if (oldest === undefined) {
				// One run alone past the cap: drop its oldest packets, which the reader reads again if asked.
				const drop = Math.floor(keep.packets.length / 2)

				keep.start = keep.packets[drop]?.unit ?? keep.start
				keep.packets.splice(0, drop)

				return
			}

			total -= oldest.packets.length
			this.runs.splice(this.runs.indexOf(oldest), 1)
		}
	}

	private runOf(sequence: number): Run | null {
		return (
			this.runs.find(run => {
				const first = run.packets[0]

				return first !== undefined && sequenceOf(first) <= sequence && sequence <= lastSequence(run)
			}) ?? null
		)
	}

	// Index of the packet `sequence` in `run`, by binary search.
	private static indexOf(run: Run, sequence: number): number {
		let low = 0
		let high = run.packets.length - 1

		while (low <= high) {
			const middle = (low + high) >> 1
			const packet = run.packets[middle]
			const at = packet === undefined ? 0 : sequenceOf(packet)

			if (at === sequence) {
				return middle
			}

			if (at < sequence) {
				low = middle + 1
			} else {
				high = middle - 1
			}
		}

		return -1
	}

	private static span(run: Run, track: number): { first: number; last: number } | null {
		let first = Infinity
		let last = -Infinity

		for (const packet of run.packets) {
			if (packet.track === track) {
				first = Math.min(first, packet.pts)
				last = Math.max(last, packet.pts)
			}
		}

		return Number.isFinite(first) ? { first, last } : null
	}

	// A run whose packets of `track` reach from at or before `target` past it (or to the end of the file).
	private async covering(reader: ContainerReader, track: number, target: number): Promise<Run> {
		for (let jumps = 0; ;) {
			// Out of jumps with nothing at or before the target: read forward from the data's start.
			const best = this.bestRun(track, target) ?? (jumps >= MAX_JUMPS ? this.runAt(reader.dataStart) : null)

			if (best !== null) {
				const span = PacketDemuxer.span(best, track)

				if (best.done || (span !== null && span.last > target + REORDER_MARGIN_SECONDS)) {
					return best
				}

				if (jumps >= MAX_JUMPS || this.closeEnough(reader, best, target)) {
					await this.advance(reader, best)

					continue
				}
			}

			jumps++

			const position = await this.locate(reader, track, target)
			const run = this.runAt(position)

			while (!run.done && PacketDemuxer.span(run, track) === null) {
				await this.advance(reader, run)
			}

			const span = PacketDemuxer.span(run, track)

			// The data's start is already past the target: nothing earlier exists.
			if ((span === null || span.first > target) && position <= reader.dataStart) {
				return run
			}
		}
	}

	// The run with the latest first packet of `track` at or before `target`.
	private bestRun(track: number, target: number): Run | null {
		let best: Run | null = null
		let bestFirst = -Infinity

		for (const run of this.runs) {
			const span = PacketDemuxer.span(run, track)

			if (span !== null && span.first <= target && span.first > bestFirst) {
				best = run
				bestFirst = span.first
			}
		}

		return best
	}

	private closeEnough(reader: ContainerReader, run: Run, target: number): boolean {
		const span = PacketDemuxer.anySpan(run)

		if (span === null) {
			return true
		}

		const rate = this.byteRate(reader)

		return rate === null || (target - span.last) * rate < READ_FORWARD_BYTES
	}

	private static anySpan(run: Run): { first: number; last: number } | null {
		const first = run.packets[0]
		const last = run.packets.at(-1)

		return first === undefined || last === undefined ? null : { first: first.pts, last: last.pts }
	}

	private byteRate(reader: ContainerReader): number | null {
		const duration = reader.duration
		const size = this.input._reader.fileSize

		return duration === null || duration <= 0 || size === null ? null : (size - reader.dataStart) / duration
	}

	// Where to start reading for `target`: the index's position, else an interpolation between the nearest known
	// positions around it (the data's start and end, and every run read so far), resynced to a unit boundary.
	private async locate(reader: ContainerReader, track: number, target: number): Promise<number> {
		const indexed = (await reader.indexedPosition?.(target)) ?? null

		if (indexed !== null) {
			return indexed
		}

		const offset = await this.timeOffset(reader)
		const size = this.input._reader.fileSize ?? reader.dataStart
		let low = { pos: reader.dataStart, pts: offset }
		let high = { pos: size, pts: offset + (reader.duration ?? 0) }

		for (const run of this.runs) {
			const span = PacketDemuxer.span(run, track)

			if (span === null) {
				continue
			}

			if (span.first <= target && run.start > low.pos) {
				low = { pos: run.start, pts: span.first }
			} else if (span.first > target && run.start < high.pos) {
				high = { pos: run.start, pts: span.first }
			}
		}

		if (high.pts <= low.pts || high.pos - low.pos < READ_FORWARD_BYTES) {
			return low.pos
		}

		const estimate = Math.floor(low.pos + ((target - low.pts) / (high.pts - low.pts)) * (high.pos - low.pos))

		// A little before the estimate, so a unit boundary found after it still comes before the target; further back
		// while the boundary found is the known point after the target.
		for (let back = SEEK_BACKOFF_BYTES; ; back *= 4) {
			const guess = estimate - back

			if (guess <= low.pos) {
				return low.pos
			}

			const synced = await reader.resync(guess)

			if (synced !== null && synced < high.pos) {
				return synced
			}
		}
	}

	private async packet(reader: ContainerReader, packet: DemuxPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const offset = await this.timeOffset(reader)
		const data = options.metadataOnly === true ? NO_DATA : (packet.payload ?? (await readAt(this.input, packet.pos, packet.size)))

		if (data === null) {
			return null
		}

		return new EncodedPacket(
			data,
			packet.key ? "key" : "delta",
			packet.pts - offset,
			packet.duration,
			sequenceOf(packet),
			packet.payload?.length ?? packet.size
		)
	}

	public async first(track: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const reader = await this.open
		const found = await this.mutex.run(async () => {
			await this.timeOffset(reader)

			const run = this.runAt(reader.dataStart)

			for (let index = 0; ; index++) {
				const packet = run.packets[index]

				if (packet?.track === track) {
					return packet
				}

				if (packet === undefined) {
					if (run.done) {
						return null
					}

					await this.advance(reader, run)
					index--
				}
			}
		})

		return found === null ? null : this.packet(reader, found, options)
	}

	// The packet of `track` after `sequence` in decode order, a key one when `key`.
	public async next(track: number, sequence: number, key: boolean, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const reader = await this.open
		const found = await this.mutex.run(async () => {
			await this.timeOffset(reader)

			// A run dropped since is read again from the packet's unit.
			const run = this.runOf(sequence) ?? this.runAt(Math.floor(sequence / MAX_PARTS))

			while (run.packets.length === 0 && !run.done) {
				await this.advance(reader, run)
			}

			let index = PacketDemuxer.indexOf(run, sequence)

			if (index === -1) {
				return null
			}

			for (index++; ; index++) {
				const packet = run.packets[index]

				if (packet === undefined) {
					if (run.done) {
						return null
					}

					// Advancing may merge a later run in; positions keep the index valid.
					await this.advance(reader, run)
					index--

					continue
				}

				if (packet.track === track && (!key || packet.key)) {
					return packet
				}
			}
		})

		return found === null ? null : this.packet(reader, found, options)
	}

	// The packet of `track` presented at `timestamp` (the latest at or before it), a key one when `key`.
	public async at(track: number, timestamp: number, key: boolean, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const reader = await this.open
		const found = await this.mutex.run(async () => {
			const target = timestamp + (await this.timeOffset(reader))
			const run = await this.covering(reader, track, target)
			const exact = PacketDemuxer.latest(run, track, target, key)

			if (exact !== null || !key) {
				return exact
			}

			// No key picture between this run's start and the target: look further back until one is found or the file
			// starts.
			for (let back = KEY_BACKOFF_SECONDS; ; back *= 2) {
				const earlier = await this.covering(reader, track, target - back)

				while (!earlier.done && (PacketDemuxer.span(earlier, track)?.last ?? -Infinity) <= target) {
					await this.advance(reader, earlier)
				}

				const keyed = PacketDemuxer.latest(earlier, track, target, true)

				if (keyed !== null || earlier.start <= reader.dataStart) {
					return keyed
				}
			}
		})

		return found === null ? null : this.packet(reader, found, options)
	}

	// The packet of `track` in `run` with the latest presentation time at or before `target`, a key one when `key`.
	private static latest(run: Run, track: number, target: number, key: boolean): DemuxPacket | null {
		let found: DemuxPacket | null = null

		for (const packet of run.packets) {
			if (packet.track === track && packet.pts <= target && (!key || packet.key) && (found === null || packet.pts >= found.pts)) {
				found = packet
			}
		}

		return found
	}
}

const NO_DISPOSITION: TrackDisposition = {
	default: false,
	primary: false,
	forced: false,
	original: false,
	commentary: false,
	hearingImpaired: false,
	visuallyImpaired: false
}

abstract class Backing<T extends DemuxTrack> {
	protected readonly demuxer: PacketDemuxer
	protected readonly track: T

	public constructor(demuxer: PacketDemuxer, track: T) {
		this.demuxer = demuxer
		this.track = track
	}

	public abstract getType(): "video" | "audio"

	public getNumber(): number {
		return this.track.number
	}

	public getInternalCodecId(): string | number | null {
		return this.track.internalCodecId
	}

	public getName(): string | null {
		return this.track.name
	}

	public getLanguageCode(): string {
		return this.track.language
	}

	public getTimeResolution(): number {
		return this.track.type === "audio" ? this.track.sampleRate : 90_000
	}

	public isRelativeToUnixEpoch(): boolean {
		return false
	}

	public getUnixTimeForTimestamp(): number | null {
		return null
	}

	public getDisposition(): TrackDisposition {
		return { ...NO_DISPOSITION, default: this.track.isDefault, primary: this.track.isDefault }
	}

	public getPairingMask(): bigint {
		return 1n
	}

	public getBitrate(): number | null {
		return null
	}

	public getAverageBitrate(): number | null {
		return null
	}

	public async getDurationFromMetadata(): Promise<number | null> {
		return this.demuxer.duration()
	}

	public async getLiveRefreshInterval(): Promise<number | null> {
		return Promise.resolve(null)
	}

	public getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.demuxer.first(this.track.number, options)
	}

	public getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.demuxer.at(this.track.number, timestamp, false, options)
	}

	public getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.demuxer.next(this.track.number, packet.sequenceNumber, false, options)
	}

	public getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.demuxer.at(this.track.number, timestamp, true, options)
	}

	public getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.demuxer.next(this.track.number, packet.sequenceNumber, true, options)
	}
}

class VideoBacking extends Backing<DemuxVideoTrack> implements InputVideoTrackBacking {
	public getType(): "video" {
		return "video"
	}

	public getCodec(): VideoCodec | null {
		return this.track.codec
	}

	public getCodedWidth(): number {
		return this.track.width
	}

	public getCodedHeight(): number {
		return this.track.height
	}

	public getSquarePixelWidth(): number {
		return this.track.squarePixelWidth
	}

	public getSquarePixelHeight(): number {
		return this.track.squarePixelHeight
	}

	public getTransformationMatrix(): [number, number, number, number, number, number, number, number, number] {
		return [1, 0, 0, 0, 1, 0, 0, 0, 1]
	}

	public async getColorSpace(): Promise<VideoColorSpaceInit> {
		return Promise.resolve(this.track.decoderConfig?.colorSpace ?? {})
	}

	public async canBeTransparent(): Promise<boolean> {
		return Promise.resolve(false)
	}

	public async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return Promise.resolve(this.track.decoderConfig)
	}
}

class AudioBacking extends Backing<DemuxAudioTrack> implements InputAudioTrackBacking {
	public getType(): "audio" {
		return "audio"
	}

	public getCodec(): AudioCodec | null {
		return this.track.codec
	}

	public getNumberOfChannels(): number {
		return this.track.channels
	}

	public getSampleRate(): number {
		return this.track.sampleRate
	}

	public async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return Promise.resolve(this.track.decoderConfig)
	}
}
