import { CustomSource, EncodedPacketSink, Input, type InputAudioTrack } from "mediabunny"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { BlockCache } from "@/lib/media/blockCache"
import { BLOCK_INPUT_FORMATS } from "@/lib/media/blockInput"
import { WaveformBuckets } from "@/features/preview/videoEdit/worker/preview.logic"
import type { TimeRange } from "@/features/preview/videoEdit/types"

// The timeline's waveform, made only from bytes something else already downloaded: the tap reads the file through
// its own demuxer whose every read is answered from the resident blocks of the shared block cache or refused, so it
// never downloads anything. When a block lands, the buckets whose audio lies in it are decoded (a few packets each,
// with AudioDecoder) and their peaks published; buckets with nothing fetched yet stay NaN.
//
// Its own demuxer, not the preview's: a refused read can leave a demuxer mid-parse, which must never break frame
// decoding. The cost is a second copy of the container's index (for an MP4, the moov box and the audio track's table).

export class NotResidentError extends Error {
	public readonly offset: number

	public constructor(offset: number) {
		super("bytes not resident")
		this.name = "NotResidentError"
		this.offset = offset
	}
}

// The first sweep probes every SKELETON_STRIDE-th bucket, learning where the file keeps its audio.
const SKELETON_STRIDE = 32
// Packets decoded per bucket at most (a sample of its audio, not all of it).
const PACKETS_PER_BUCKET = 4
// Probes between yields, so frame requests interleave.
const PROBES_PER_SLICE = 48
// Subscribers hear at most this often.
const PUBLISH_MS = 200
// After this many header reads are refused, the tap waits for more blocks before trying to open again.
const OPEN_RETRY_BLOCKS = 2

interface Subscriber {
	range: TimeRange
	columns: number
	onUpdate: (peaks: Float32Array) => void
}

export interface WaveformTapOptions {
	cache: BlockCache
	size: number
	duration: number
	createDecoder?: (init: AudioDecoderInit) => AudioDecoder
	isConfigSupported?: (config: AudioDecoderConfig) => Promise<boolean>
	// Called between probe slices; the default yields a macrotask.
	yieldSlice?: () => Promise<void>
}

function defaultYield(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

export class WaveformTap {
	private readonly options: WaveformTapOptions
	private readonly buckets: WaveformBuckets
	private readonly subscribers = new Map<number, Subscriber>()
	private input: Input | null = null
	private sink: EncodedPacketSink | null = null
	private decoder: AudioDecoder | null = null
	private config: AudioDecoderConfig | null = null
	// Null: not opened yet; false: no decodable audio, never again.
	private opened: boolean | null = null
	private opening: Promise<void> | null = null
	private blocksSinceOpenFailed = 0
	private readonly queuedBlocks: number[] = []
	private skeletonDone = false
	private running = false
	private closed = false
	private publishTimer: ReturnType<typeof setTimeout> | undefined
	private dirty = false
	private bucketPeak = 0
	private scratch = new Float32Array(0)
	private packetsPerBucket = 1
	// Where the last refused read began (the demuxer may wrap the error it saw); null when none was refused.
	private lastMiss: number | null = null

	public constructor(options: WaveformTapOptions) {
		this.options = options
		this.buckets = new WaveformBuckets(options.duration)
	}

	public get bucketGrid(): WaveformBuckets {
		return this.buckets
	}

	// Opens the tap's demuxer while the header blocks are resident, then catches up with what is.
	public start(): void {
		this.run()
	}

	// A block of the shared cache landed.
	public onBlock(index: number): void {
		if (this.closed || this.opened === false) {
			return
		}

		this.queuedBlocks.push(index)
		this.blocksSinceOpenFailed++
		this.run()
	}

	public subscribe(id: number, range: TimeRange, columns: number, onUpdate: (peaks: Float32Array) => void): void {
		this.subscribers.set(id, { range, columns, onUpdate })
		onUpdate(this.buckets.columns(range, columns))
		this.run()
	}

	public unsubscribe(id: number): void {
		this.subscribers.delete(id)
	}

	public get subscriberCount(): number {
		return this.subscribers.size
	}

	public close(): void {
		this.closed = true
		clearTimeout(this.publishTimer)
		this.subscribers.clear()
		this.queuedBlocks.length = 0
		this.disposeInput()

		if (this.decoder !== null && this.decoder.state !== "closed") {
			this.decoder.close()
		}

		this.decoder = null
	}

	// Read through methods: the reads that set these run inside the demuxer's awaits.
	private missed(): number | null {
		return this.lastMiss
	}

	private isOpen(): boolean {
		return this.opened === true
	}

	private disposeInput(): void {
		this.input?.dispose()
		this.input = null
		this.sink = null
	}

	// Reads answered from resident blocks only.
	private read(start: number, end: number): Uint8Array {
		const clampedEnd = Math.min(end, this.options.size)

		if (clampedEnd <= start) {
			return new Uint8Array(0)
		}

		const bytes = this.options.cache.peek(start, clampedEnd)

		if (bytes === null) {
			this.lastMiss = start

			throw new NotResidentError(start)
		}

		return bytes
	}

	private async open(): Promise<void> {
		const input = new Input({
			formats: BLOCK_INPUT_FORMATS,
			source: new CustomSource({
				getSize: () => this.options.size,
				read: (start, end) => this.read(start, end),
				prefetchProfile: "none",
				maxCacheSize: 0
			})
		})

		this.input = input
		this.lastMiss = null

		let track: InputAudioTrack | null

		try {
			track = (await input.getAudioTracks())[0] ?? null
		} catch {
			this.disposeInput()

			if (this.missed() !== null) {
				// The header is not all resident yet: try again once more blocks came.
				this.blocksSinceOpenFailed = 0

				return
			}

			this.opened = false

			return
		}

		const config = track === null ? null : await track.getDecoderConfig().catch(() => null)
		const supported =
			config !== null &&
			typeof AudioDecoder !== "undefined" &&
			(await (this.options.isConfigSupported ?? defaultSupport)(config).catch(() => false))

		if (track === null || config === null || !supported || this.closed) {
			this.disposeInput()
			this.opened = false

			return
		}

		const first = await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true }).catch(() => null)
		const packetSeconds = first?.duration ?? 0.02

		this.packetsPerBucket = Math.max(1, Math.min(PACKETS_PER_BUCKET, Math.round(this.buckets.width / Math.max(packetSeconds, 1e-3))))
		this.sink = new EncodedPacketSink(track)
		this.config = config
		this.opened = true
		// What landed before the tap could read it, and is still here.
		this.options.cache.forEachResident(index => {
			this.queuedBlocks.push(index)
		})
	}

	private ensureDecoder(): AudioDecoder | null {
		if (this.config === null) {
			return null
		}

		if (this.decoder === null || this.decoder.state === "closed") {
			const create = this.options.createDecoder ?? ((init: AudioDecoderInit) => new AudioDecoder(init))

			this.decoder = create({
				output: data => {
					this.bucketPeak = Math.max(this.bucketPeak, this.peakOf(data))
					data.close()
				},
				error: () => undefined
			})
			this.decoder.configure(this.config)
		}

		return this.decoder
	}

	private peakOf(data: AudioData): number {
		const frames = data.numberOfFrames

		if (this.scratch.length < frames) {
			this.scratch = new Float32Array(frames)
		}

		let peak = 0

		for (let channel = 0; channel < data.numberOfChannels; channel++) {
			data.copyTo(this.scratch, { planeIndex: channel, format: "f32-planar", frameCount: frames })

			for (let i = 0; i < frames; i++) {
				const value = Math.abs(this.scratch[i] ?? 0)

				if (value > peak) {
					peak = value
				}
			}
		}

		return peak
	}

	// Runs the queued work one slice at a time until nothing is left; one runner at a time.
	private run(): void {
		if (this.running || this.closed) {
			return
		}

		this.running = true
		void this.work().finally(() => {
			this.running = false

			if (!this.closed && (this.queuedBlocks.length > 0 || (this.opened === true && !this.skeletonDone))) {
				this.run()
			}
		})
	}

	private async work(): Promise<void> {
		if (this.opened === null) {
			if (this.input === null && (this.opening === null || this.blocksSinceOpenFailed >= OPEN_RETRY_BLOCKS)) {
				this.opening = this.open()
			}

			await this.opening

			if (!this.isOpen()) {
				this.queuedBlocks.length = 0

				return
			}
		}

		if (!this.isOpen()) {
			return
		}

		if (!this.skeletonDone) {
			await this.probeAll(this.buckets.skeleton(SKELETON_STRIDE))
			this.skeletonDone = true
		}

		while (this.queuedBlocks.length > 0 && !this.closed) {
			const index = this.queuedBlocks.shift() ?? 0
			const start = index * BLOCK_BYTES

			await this.probeAll(this.buckets.candidatesFor(start, Math.min(this.options.size, start + BLOCK_BYTES)))
		}
	}

	private async probeAll(buckets: readonly number[]): Promise<void> {
		for (let i = 0; i < buckets.length && !this.closed; i++) {
			await this.probe(buckets[i] ?? 0)

			if ((i + 1) % PROBES_PER_SLICE === 0) {
				await (this.options.yieldSlice ?? defaultYield)()
			}
		}
	}

	private async probe(bucket: number): Promise<void> {
		const sink = this.sink

		if (sink === null) {
			return
		}

		const end = (bucket + 1) * this.buckets.width
		const packets = []

		this.lastMiss = null

		try {
			let packet = await sink.getPacket(this.buckets.timeOf(bucket))

			while (packet !== null && packets.length < this.packetsPerBucket && packet.timestamp < end) {
				packets.push(packet)

				if (packets.length < this.packetsPerBucket) {
					this.lastMiss = null
					packet = await sink.getNextPacket(packet).catch((error: unknown) => {
						// The bucket's later packets are not here yet: the ones in hand stand.
						if (this.missed() !== null) {
							this.lastMiss = null

							return null
						}

						throw error
					})
				}
			}
		} catch {
			const miss = this.missed()

			if (miss !== null) {
				this.buckets.pending(bucket, miss)
			} else {
				this.buckets.failed(bucket)
			}

			return
		}

		if (packets.length === 0) {
			this.buckets.failed(bucket)

			return
		}

		const decoder = this.ensureDecoder()

		if (decoder === null) {
			return
		}

		this.bucketPeak = 0

		try {
			for (const packet of packets) {
				decoder.decode(packet.toEncodedAudioChunk())
			}

			await decoder.flush()
		} catch {
			// A decoder error closes it; the next bucket gets a fresh one.
			this.buckets.failed(bucket)

			return
		}

		this.buckets.done(bucket, this.bucketPeak)
		this.schedulePublish()
	}

	private schedulePublish(): void {
		this.dirty = true

		if (this.publishTimer !== undefined) {
			return
		}

		this.publishTimer = setTimeout(() => {
			this.publishTimer = undefined

			if (!this.dirty || this.closed) {
				return
			}

			this.dirty = false

			for (const subscriber of this.subscribers.values()) {
				subscriber.onUpdate(this.buckets.columns(subscriber.range, subscriber.columns))
			}
		}, PUBLISH_MS)
	}
}

async function defaultSupport(config: AudioDecoderConfig): Promise<boolean> {
	return (await AudioDecoder.isConfigSupported(config)).supported === true
}
