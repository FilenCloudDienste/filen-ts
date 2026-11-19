import { AudioSample, type AudioSampleSource } from "mediabunny"
import type { TimeRange } from "@/features/preview/videoEdit/types"
import { throwIfCancelled } from "@/features/preview/videoEdit/worker/errors"
import type { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"

// Re-encoded audio: decoded samples cut to the kept ranges sample-exactly, a gain, a pitch-keeping time stretch for a
// speed change, and an exact count of output frames per range (the stretch's own rounding is padded or trimmed), so
// the audio's running length matches the video's to the sample after any number of joins. A sample is laid where its
// timestamp puts it: audio that starts after the range does, or has a hole, gets that much silence first (the video is
// laid from the range's start too), so it stays in sync instead of sliding early.

// The time stretch (audio/timeStretch.ts, WSOLA): planar in, planar out (views valid until its next call).
export interface TimeStretchLike {
	push(planar: readonly Float32Array[]): Float32Array[]
	flush(): Float32Array[]
}

// The part of a decoded AudioSample RangeAudio reads: its planes copied out as 32-bit float.
export interface PlanarSampleLike {
	readonly timestamp: number
	readonly numberOfFrames: number
	readonly numberOfChannels: number
	copyTo(destination: Float32Array, options: { planeIndex: number; format: "f32-planar"; frameOffset: number; frameCount: number }): void
}

// Frames of silence emitted at once when a range's audio ends short of its video or has a gap.
const PAD_BLOCK_FRAMES = 8192

// The most a sample may be amplified to: louder clips, and an encoder fed values past full scale distorts worse.
const FULL_SCALE = 1

export function gainFactor(gainDb: number): number {
	return gainDb === 0 ? 1 : 10 ** (gainDb / 20)
}

function frames(planes: readonly Float32Array[]): number {
	return planes[0]?.length ?? 0
}

function sliceAll(planes: readonly Float32Array[], from: number, to: number): Float32Array[] {
	return planes.map(plane => plane.subarray(from, to))
}

// One track's PCM, range after range, as exact frame counts on the output timeline.
export class RangeAudio {
	private readonly sampleRate: number
	private readonly channels: number
	private readonly gain: number
	private readonly speed: number
	private readonly createStretch: (() => TimeStretchLike) | null
	private range: TimeRange = { start: 0, end: 0 }
	private target = 0
	private stretch: TimeStretchLike | null = null
	private writtenFrames = 0
	// Source frames of this range laid down so far (kept audio and silence for gaps): where the next sample belongs.
	private sourceFrames = 0
	private elapsed = 0
	// Silence for gaps, read only, shared by every channel.
	private zeros: Float32Array | null = null
	// The kept part of the latest sample, every channel back to back; reused (grown when a sample holds more).
	private scratch = new Float32Array(0)

	public constructor(params: {
		sampleRate: number
		channels: number
		gainDb: number
		speed: number
		createStretch: (() => TimeStretchLike) | null
	}) {
		this.sampleRate = params.sampleRate
		this.channels = params.channels
		this.gain = gainFactor(params.gainDb)
		this.speed = params.speed
		this.createStretch = params.speed === 1 ? null : params.createStretch
	}

	// Frames emitted so far: the output position of the next.
	public get written(): number {
		return this.writtenFrames
	}

	public begin(range: TimeRange): void {
		this.range = range
		this.elapsed += range.end - range.start
		this.target = Math.round((this.elapsed / this.speed) * this.sampleRate)
		this.stretch = this.createStretch?.() ?? null
		this.sourceFrames = 0
	}

	// Silence for the gap before `sample`, when it starts more than a packet (its own length) past the audio laid so
	// far in this range: the source's own gap, kept in place. Under a packet is AAC priming or timestamp jitter, never
	// filled (it would click). Fed through the stretch like audio, so the range's frame count stays exact. Call before
	// push(); each block is valid until the next is asked for.
	public *gap(sample: PlanarSampleLike): Generator<Float32Array[]> {
		const from = Math.max(0, Math.round((this.range.start - sample.timestamp) * this.sampleRate))
		const to = Math.min(sample.numberOfFrames, Math.round((this.range.end - sample.timestamp) * this.sampleRate))

		if (to <= from) {
			return
		}

		const at = Math.round((Math.max(sample.timestamp, this.range.start) - this.range.start) * this.sampleRate)
		let missing = at - this.sourceFrames

		if (missing <= sample.numberOfFrames) {
			return
		}

		this.sourceFrames = at
		this.zeros ??= new Float32Array(PAD_BLOCK_FRAMES)

		while (missing > 0 && this.writtenFrames < this.target) {
			const count = Math.min(PAD_BLOCK_FRAMES, missing)
			const block = this.zeros.subarray(0, count)
			const planes = Array.from({ length: this.channels }, () => block)
			const taken = this.take(this.stretch === null ? planes : this.stretch.push(planes))

			missing -= count

			if (taken !== null) {
				yield taken
			}
		}
	}

	// What of a decoded sample (source seconds) falls in the range, ready to encode, or null. Only that part is copied
	// out, once, into a buffer reused across samples, the gain applied in place: the planes returned are views of it
	// (or of the stretch's output), valid until the next push.
	public push(sample: PlanarSampleLike): Float32Array[] | null {
		const from = Math.max(0, Math.round((this.range.start - sample.timestamp) * this.sampleRate))
		const to = Math.min(sample.numberOfFrames, Math.round((this.range.end - sample.timestamp) * this.sampleRate))

		if (to <= from || sample.numberOfChannels < 1) {
			return null
		}

		const count = to - from

		this.sourceFrames += count

		if (this.scratch.length < count * this.channels) {
			this.scratch = new Float32Array(count * this.channels)
		}

		const planes: Float32Array[] = []

		for (let channel = 0; channel < this.channels; channel++) {
			const plane = this.scratch.subarray(channel * count, (channel + 1) * count)

			// A decoder that returns fewer planes than the track declares: the first stands in.
			sample.copyTo(plane, {
				planeIndex: channel < sample.numberOfChannels ? channel : 0,
				format: "f32-planar",
				frameOffset: from,
				frameCount: count
			})

			if (this.gain !== 1) {
				for (let index = 0; index < count; index++) {
					plane[index] = Math.max(-FULL_SCALE, Math.min(FULL_SCALE, (plane[index] ?? 0) * this.gain))
				}
			}

			planes.push(plane)
		}

		return this.take(this.stretch === null ? planes : this.stretch.push(planes))
	}

	// The rest of the range: the stretch's tail, then silence up to the range's exact length.
	public *end(): Generator<Float32Array[]> {
		if (this.stretch !== null) {
			const tail = this.take(this.stretch.flush())

			this.stretch = null

			if (tail !== null) {
				yield tail
			}
		}

		while (this.writtenFrames < this.target) {
			const count = Math.min(PAD_BLOCK_FRAMES, this.target - this.writtenFrames)

			this.writtenFrames += count

			yield Array.from({ length: this.channels }, () => new Float32Array(count))
		}
	}

	private take(planes: readonly Float32Array[]): Float32Array[] | null {
		const room = this.target - this.writtenFrames
		const count = Math.min(room, frames(planes))

		if (count <= 0) {
			return null
		}

		this.writtenFrames += count

		return count === frames(planes) ? [...planes] : sliceAll(planes, 0, count)
	}
}

export function planarSample(planes: readonly Float32Array[], sampleRate: number, timestamp: number): AudioSample {
	const count = frames(planes)
	const data = new Float32Array(count * planes.length)

	planes.forEach((plane, channel) => {
		data.set(plane, channel * count)
	})

	return new AudioSample({ data, format: "f32-planar", numberOfChannels: planes.length, sampleRate, timestamp })
}

export interface AudioFormat {
	sampleRate: number
	channels: number
}

// The rate and channel count the decoder puts out, read from the first sample it decodes in the first of `bounds` that
// holds one (closed at once): a track's declared ones (its AudioSpecificConfig) can differ, as implicitly signalled
// HE-AAC decodes at twice the rate and v2 turns one channel into two. `declared` when no range decodes anything.
export async function decodedAudioFormat(
	decode: (range: TimeRange) => AsyncIterable<AudioSample>,
	bounds: readonly TimeRange[],
	declared: AudioFormat
): Promise<AudioFormat> {
	for (const range of bounds) {
		for await (const sample of decode(range)) {
			try {
				return {
					sampleRate: sample.sampleRate > 0 ? sample.sampleRate : declared.sampleRate,
					channels: sample.numberOfChannels > 0 ? sample.numberOfChannels : declared.channels
				}
			} finally {
				sample.close()
			}
		}
	}

	return declared
}

export interface TranscodeAudioParams {
	// Decoded samples covering `range` (from the one holding its start), in order. Each is closed by the caller.
	decode: (range: TimeRange) => AsyncIterable<AudioSample>
	bounds: readonly TimeRange[]
	audio: RangeAudio
	sampleRate: number
	output: AudioSampleSource
	gate: InterleaveGate
	lane: string
	signal: AbortSignal
}

export async function transcodeAudio(params: TranscodeAudioParams): Promise<void> {
	const { audio, sampleRate, output, gate, lane, signal } = params
	const emit = async (planes: readonly Float32Array[]): Promise<void> => {
		const timestamp = (audio.written - frames(planes)) / sampleRate
		const sample = planarSample(planes, sampleRate, timestamp)

		try {
			await gate.advance(lane, timestamp)
			throwIfCancelled(signal)
			await output.add(sample)
		} finally {
			sample.close()
		}
	}

	for (const range of params.bounds) {
		audio.begin(range)

		for await (const sample of params.decode(range)) {
			let planes: Float32Array[] | null

			try {
				throwIfCancelled(signal)

				for (const silence of audio.gap(sample)) {
					await emit(silence)
				}

				planes = audio.push(sample)
			} finally {
				sample.close()
			}

			if (planes !== null) {
				await emit(planes)
			}
		}

		for (const planes of audio.end()) {
			await emit(planes)
		}
	}

	gate.finish(lane)
}
