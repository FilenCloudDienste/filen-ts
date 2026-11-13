import type { VideoProbe } from "@filen/shared/videos"
import type {
	TimeRange,
	TransferCharacteristic,
	VideoRotation,
	VideoSourceAudioTrack,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"

// The preview worker's decisions, free of WebCodecs and the demuxer: which decoded frame answers a request, which
// keyframes a filmstrip decodes, how the waveform's buckets fill and are read out, and how the source's facts are
// put together. preview.worker.ts and its modules do the decoding and reading.

// ── Frames ──────────────────────────────────────────────────────────────────

export interface Timestamped {
	readonly timestamp: number
	close(): void
}

// Picks the frame for `target` (µs) from decoded frames in presentation order. Frames before it become the
// candidate (the closest one at or before the target, kept in case the target never comes); the exact frame is
// returned; a later frame means the target will not come (dropped, undecodable), so the candidate (else that later
// frame) answers. Null: keep decoding. Every frame passed over is closed; frames after the answer stay queued.
export function pickFrame<F extends Timestamped>(queue: F[], target: number, candidate: { frame: F | null }): F | null {
	for (let head = queue[0]; head !== undefined; head = queue[0]) {
		if (head.timestamp < target) {
			queue.shift()
			candidate.frame?.close()
			candidate.frame = head

			continue
		}

		if (head.timestamp === target) {
			queue.shift()
			candidate.frame?.close()
			candidate.frame = null

			return head
		}

		const best = candidate.frame

		if (best === null) {
			queue.shift()

			return head
		}

		candidate.frame = null

		return best
	}

	return null
}

// ── Filmstrip ───────────────────────────────────────────────────────────────

export interface FilmstripSlot {
	// The keyframe's own time (seconds) and the requested positions (indexes) it stands for.
	keyTime: number
	positions: number[]
}

// `keys[i]` is the keyframe time for requested time i (null: none). Requests sharing a keyframe share its slot; past
// `max` distinct keyframes the rest are dropped (the filmstrip asks again). Slots in time order, so a file read walks
// forward.
export function planFilmstrip(keys: readonly (number | null)[], max: number): FilmstripSlot[] {
	const byTime = new Map<number, FilmstripSlot>()

	for (const [position, keyTime] of keys.entries()) {
		if (keyTime === null) {
			continue
		}

		const slot = byTime.get(keyTime)

		if (slot !== undefined) {
			slot.positions.push(position)
		} else if (byTime.size < max) {
			byTime.set(keyTime, { keyTime, positions: [position] })
		}
	}

	return [...byTime.values()].sort((a, b) => a.keyTime - b.keyTime)
}

// A filmstrip still `height` px high in display orientation (the source's rotation applied), at least 1 px wide.
export function filmstripSize(display: { width: number; height: number }, height: number): { width: number; height: number } {
	const h = Math.max(1, Math.round(height))

	return { width: Math.max(1, Math.round((display.width / display.height) * h)), height: h }
}

// ── Priority lock ───────────────────────────────────────────────────────────

export type LockPriority = "interactive" | "background"

// One holder at a time (the decoder); an interactive waiter (frameAt) goes before any background one (filmstrip,
// waveform), each class in arrival order.
export class PriorityLock {
	private held = false
	private readonly interactive: (() => void)[] = []
	private readonly background: (() => void)[] = []

	public get waiting(): { interactive: number; background: number } {
		return { interactive: this.interactive.length, background: this.background.length }
	}

	public acquire(priority: LockPriority): Promise<() => void> {
		return new Promise(resolve => {
			const grant = (): void => {
				this.held = true

				let released = false

				resolve(() => {
					if (!released) {
						released = true
						this.release()
					}
				})
			}

			if (!this.held) {
				grant()
			} else {
				;(priority === "interactive" ? this.interactive : this.background).push(grant)
			}
		})
	}

	private release(): void {
		this.held = false

		const next = this.interactive.shift() ?? this.background.shift()

		next?.()
	}
}

// ── Waveform ────────────────────────────────────────────────────────────────

// The finest a waveform bucket gets, and the most buckets a file gets: a long file's buckets are wider.
export const WAVEFORM_MIN_BUCKET_SECONDS = 0.05
export const WAVEFORM_MAX_BUCKETS = 20_000

export const BucketState = {
	Unknown: 0,
	// Its packet's bytes are not resident; its offset says where they are.
	Pending: 1,
	Done: 2,
	// No packet, or it would not decode: never tried again.
	Failed: 3
} as const

export type BucketState = (typeof BucketState)[keyof typeof BucketState]

// The waveform's fixed grid over the file: one peak per bucket (NaN until known) and what each bucket waits for.
export class WaveformBuckets {
	public readonly count: number
	public readonly width: number
	public readonly duration: number
	private readonly peaks: Float32Array
	private readonly offsets: Float64Array
	private readonly states: Uint8Array

	public constructor(duration: number) {
		this.duration = Math.max(0, duration)
		this.count = Math.max(1, Math.min(WAVEFORM_MAX_BUCKETS, Math.ceil(this.duration / WAVEFORM_MIN_BUCKET_SECONDS)))
		this.width = this.duration / this.count
		this.peaks = new Float32Array(this.count).fill(Number.NaN)
		this.offsets = new Float64Array(this.count).fill(Number.NaN)
		this.states = new Uint8Array(this.count)
	}

	public state(bucket: number): BucketState {
		return (this.states[bucket] ?? BucketState.Failed) as BucketState
	}

	// The time a bucket's probe looks at: its middle.
	public timeOf(bucket: number): number {
		return (bucket + 0.5) * this.width
	}

	public bucketOf(time: number): number {
		return Math.min(this.count - 1, Math.max(0, Math.floor(time / (this.width || 1))))
	}

	public offsetOf(bucket: number): number {
		return this.offsets[bucket] ?? Number.NaN
	}

	public pending(bucket: number, offset: number): void {
		this.states[bucket] = BucketState.Pending
		this.offsets[bucket] = offset
	}

	public done(bucket: number, peak: number): void {
		this.states[bucket] = BucketState.Done
		this.peaks[bucket] = Math.min(1, Math.max(0, peak))
	}

	public failed(bucket: number): void {
		this.states[bucket] = BucketState.Failed
	}

	public peakOf(bucket: number): number {
		return this.peaks[bucket] ?? Number.NaN
	}

	// The buckets worth probing once bytes [start, end) are resident: pending ones whose bytes start there, and unknown
	// ones that lie between the last bucket known to start before `start` and the first known to start at or after
	// `end` (offsets grow with time within a track). In time order.
	public candidatesFor(start: number, end: number): number[] {
		let low = 0
		let high = this.count - 1

		for (let bucket = 0; bucket < this.count; bucket++) {
			const offset = this.offsets[bucket] ?? Number.NaN

			if (Number.isNaN(offset)) {
				continue
			}

			if (offset < start) {
				low = bucket
			} else if (offset >= end) {
				high = bucket

				break
			}
		}

		const out: number[] = []

		for (let bucket = low; bucket <= high; bucket++) {
			const state = this.states[bucket]
			const offset = this.offsets[bucket] ?? Number.NaN

			if (state === BucketState.Unknown || (state === BucketState.Pending && offset >= start && offset < end)) {
				out.push(bucket)
			}
		}

		return out
	}

	// Every `stride`-th unknown bucket: a first sweep that learns where the file keeps its audio.
	public skeleton(stride: number): number[] {
		const out: number[] = []

		for (let bucket = 0; bucket < this.count; bucket += Math.max(1, stride)) {
			if (this.states[bucket] === BucketState.Unknown) {
				out.push(bucket)
			}
		}

		return out
	}

	// Peaks for `columns` equal columns over `range`: each the loudest known bucket it overlaps, NaN when none is known.
	public columns(range: TimeRange, columns: number): Float32Array {
		const count = Math.max(0, Math.floor(columns))
		const out = new Float32Array(count).fill(Number.NaN)
		const span = range.end - range.start

		if (count === 0 || span <= 0 || this.duration <= 0) {
			return out
		}

		const step = span / count

		for (let column = 0; column < count; column++) {
			const from = range.start + column * step
			const to = from + step
			const first = this.bucketOf(from)
			// A column that ends exactly on a bucket edge does not reach into the next bucket.
			const last = Math.max(first, Math.min(this.count - 1, Math.ceil(to / (this.width || 1)) - 1))
			let peak = Number.NaN

			for (let bucket = first; bucket <= last; bucket++) {
				const value = this.peaks[bucket] ?? Number.NaN

				if (!Number.isNaN(value) && !(value <= peak)) {
					peak = value
				}
			}

			out[column] = peak
		}

		return out
	}
}

// ── Source facts ────────────────────────────────────────────────────────────

const LOCATION_TAG = /(?:^|[.\s©])(?:xyz|location)/i

// Whether a container's metadata names a place: QuickTime/MP4 `©xyz`, the mdta key
// `com.apple.quicktime.location.ISO6709`, Matroska/ID3-style `location` tags.
export function hasLocationTag(raw: Readonly<Record<string, unknown>> | undefined): boolean {
	return raw !== undefined && Object.keys(raw).some(key => LOCATION_TAG.test(key))
}

export function rotationOf(degrees: number): VideoRotation {
	const turned = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360

	return turned as VideoRotation
}

export function transferOf(colorTransfer: string | null | undefined, probed: TransferCharacteristic | undefined): TransferCharacteristic {
	if (colorTransfer === "pq" || colorTransfer === "hlg") {
		return colorTransfer
	}

	return probed ?? "sdr"
}

// The container's name for VideoSourceInfo: the probe's, else mediabunny's format name lowercased ("MP4" → "mp4").
export function containerOf(probe: VideoProbe | null, formatName: string): string {
	return probe?.container ?? formatName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

export interface DemuxedFacts {
	duration: number
	displayWidth: number
	displayHeight: number
	rotation: number
	frameRate: number
	videoCodec: string | null
	colorTransfer: string | null
	keyframes: Float64Array
	audio: readonly VideoSourceAudioTrack[]
	formatName: string
	hasSubtitleTracks: boolean
	metadataRaw: Readonly<Record<string, unknown>> | undefined
	previewable: boolean
}

// What the editor learns about the source: the demuxer's facts where it is authoritative (sizes, rotation, codecs,
// keyframes, tracks), the probe's where it read further (duration of a file without one, bit depth, chapters).
export function sourceInfo(probe: VideoProbe | null, facts: DemuxedFacts, bytes: number): VideoSourceInfo {
	const transfer = transferOf(facts.colorTransfer, probe?.video?.transfer)

	return {
		duration: probe?.durationSec ?? facts.duration,
		width: facts.displayWidth,
		height: facts.displayHeight,
		rotation: rotationOf(facts.rotation),
		frameRate: facts.frameRate,
		videoCodec: facts.videoCodec,
		transfer,
		bitDepth: probe?.video?.bitDepth ?? (transfer === "sdr" ? 8 : 10),
		keyframes: facts.keyframes,
		audio: facts.audio,
		container: containerOf(probe, facts.formatName),
		hasSubtitles: facts.hasSubtitleTracks || (probe?.subs.length ?? 0) > 0,
		hasChapters: (probe?.chapters.length ?? 0) > 0,
		hasLocation: hasLocationTag(facts.metadataRaw),
		bytes,
		previewable: facts.previewable
	}
}
