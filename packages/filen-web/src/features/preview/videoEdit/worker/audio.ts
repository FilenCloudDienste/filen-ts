import { AudioSample, type AudioSampleSource } from "mediabunny"
import type { TimeRange } from "@/features/preview/videoEdit/types"
import { throwIfCancelled } from "@/features/preview/videoEdit/worker/errors"
import type { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"

// Re-encoded audio: decoded samples cut to the kept ranges sample-exactly, a gain, a pitch-keeping time stretch for a
// speed change, and an exact count of output frames per range (the stretch's own rounding is padded or trimmed), so
// the audio's running length matches the video's to the sample after any number of joins.

// The time stretch (audio/timeStretch.ts, WSOLA): planar in, planar out.
export interface TimeStretchLike {
	push(planar: readonly Float32Array[]): Float32Array[]
	flush(): Float32Array[]
}

// Frames of silence emitted at once when a range's audio ends short of its video.
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
	private elapsed = 0

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
	}

	// Decoded planes starting at `timestamp` (source seconds): what of them falls in the range, ready to encode, or null.
	public push(source: readonly Float32Array[], timestamp: number): Float32Array[] | null {
		const length = frames(source)
		const from = Math.max(0, Math.round((this.range.start - timestamp) * this.sampleRate))
		const to = Math.min(length, Math.round((this.range.end - timestamp) * this.sampleRate))

		if (to <= from) {
			return null
		}

		const planes: Float32Array[] = []

		for (let channel = 0; channel < this.channels; channel++) {
			// A decoder that returns fewer planes than the track declares: the first stands in.
			const plane = (source[channel] ?? source[0] ?? new Float32Array(length)).slice(from, to)

			if (this.gain !== 1) {
				for (let index = 0; index < plane.length; index++) {
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

export function samplePlanes(sample: AudioSample): Float32Array[] {
	const planes: Float32Array[] = []

	for (let channel = 0; channel < sample.numberOfChannels; channel++) {
		const plane = new Float32Array(sample.numberOfFrames)

		sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" })
		planes.push(plane)
	}

	return planes
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

				planes = audio.push(samplePlanes(sample), sample.timestamp)
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
