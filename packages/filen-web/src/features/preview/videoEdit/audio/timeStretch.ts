// Pitch-preserving time stretch for the video editor's speed change: WSOLA (waveform-similarity overlap-add,
// Verhelst & Roelands, ICASSP 1993). The output is built from windowed segments of the input laid down every
// SYNTHESIS hop; each segment is taken near its nominal input position (output position × speed), shifted by
// up to a tolerance so that it continues the previous segment's waveform best (normalised cross-correlation),
// which keeps the period of the signal, so its pitch, while the duration scales by 1 / speed.
//
// Streaming and allocation-free in steady state: the input sits in fixed ring buffers sized for the speed at
// construction, the overlap-add accumulator is one window long, and the correlation runs over preallocated
// scratch. Only each call's output arrays are new. All channels share one segment choice (made on their
// downmix), so the stereo image and the phase between channels are kept.

export const MIN_STRETCH_SPEED = 0.25
export const MAX_STRETCH_SPEED = 4

export interface TimeStretch {
	// Takes the next input samples (one array per channel, equal lengths) and returns what is final so far.
	push(planar: readonly Float32Array[]): Float32Array[]
	// Ends the stream: the rest, so that the whole output is round(input length / speed) samples long. Later
	// calls to push throw.
	flush(): Float32Array[]
}

// Segment (window) length; long enough for two periods of a low voice, short enough not to smear transients.
const WINDOW_SECONDS = 0.04
// How far a segment may move from its nominal position to find the best match.
const TOLERANCE_SECONDS = 0.01
// The coarse search steps through candidates at about this rate, then refines the best one sample by sample.
const COARSE_SEARCH_RATE = 16_000
// The coarse correlation looks at every DECIMATION-th sample of the overlap.
const DECIMATION = 4

function nextPowerOfTwo(n: number): number {
	let p = 1

	while (p < n) {
		p *= 2
	}

	return p
}

function channelAt(channels: readonly Float32Array[], index: number): Float32Array {
	const channel = channels[index]

	if (channel === undefined) {
		throw new RangeError(`no channel ${String(index)}`)
	}

	return channel
}

function emptyOutput(channels: number): Float32Array[] {
	return Array.from({ length: channels }, () => new Float32Array(0))
}

export function createTimeStretch(sampleRate: number, channels: number, speed: number): TimeStretch {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError(`invalid sample rate ${String(sampleRate)}`)
	}

	if (!Number.isInteger(channels) || channels < 1) {
		throw new RangeError(`invalid channel count ${String(channels)}`)
	}

	if (!(speed >= MIN_STRETCH_SPEED && speed <= MAX_STRETCH_SPEED)) {
		throw new RangeError(`speed ${String(speed)} is outside ${String(MIN_STRETCH_SPEED)}..${String(MAX_STRETCH_SPEED)}`)
	}

	return speed === 1 ? passThrough(channels) : new Wsola(sampleRate, channels, speed)
}

// Speed 1: the input unchanged (copied, so the caller may reuse its buffers).
function passThrough(channels: number): TimeStretch {
	return {
		push: planar => {
			checkPlanar(planar, channels)

			return planar.map(channel => channel.slice())
		},
		flush: () => emptyOutput(channels)
	}
}

function checkPlanar(planar: readonly Float32Array[], channels: number): number {
	if (planar.length !== channels) {
		throw new RangeError(`expected ${String(channels)} channels, got ${String(planar.length)}`)
	}

	const length = planar[0]?.length ?? 0

	for (const channel of planar) {
		if (channel.length !== length) {
			throw new RangeError("channels differ in length")
		}
	}

	return length
}

class Wsola implements TimeStretch {
	private readonly channels: number
	private readonly speed: number
	// Window length (even), synthesis hop (half of it), analysis hop (synthesis hop × speed), search tolerance.
	private readonly window: number
	private readonly hop: number
	private readonly analysisHop: number
	private readonly tolerance: number
	private readonly coarseStep: number
	// Periodic Hann: at a hop of half its length, overlapping windows sum to exactly 1.
	private readonly hann: Float32Array
	// Input rings (per channel, plus the downmix the search runs on), indexed by absolute sample number & mask.
	private readonly ring: Float32Array[]
	private readonly mono: Float32Array
	private readonly mask: number
	private inStart = 0
	private inEnd = 0
	// Overlap-add accumulator per channel: output samples [frame × hop, frame × hop + window).
	private readonly accumulator: Float32Array[]
	// Search scratch: the template and the candidate region, copied out of the ring.
	private readonly template: Float32Array
	private readonly region: Float32Array
	// Output staging per channel, reused across calls (grows when a call yields more than it holds).
	private staging: Float32Array[]
	private staged = 0
	private frame = 0
	// Input position of the previous segment; -1 before the first.
	private previous = -1
	private emitted = 0
	private flushed = false

	public constructor(sampleRate: number, channels: number, speed: number) {
		this.channels = channels
		this.speed = speed
		this.hop = Math.max(16, Math.round((WINDOW_SECONDS * sampleRate) / 2))
		this.window = this.hop * 2
		this.analysisHop = this.hop * speed
		this.tolerance = Math.min(this.hop - 1, Math.max(1, Math.round(TOLERANCE_SECONDS * sampleRate)))
		this.coarseStep = Math.max(1, Math.round(sampleRate / COARSE_SEARCH_RATE))
		this.hann = new Float32Array(this.window)

		for (let n = 0; n < this.window; n++) {
			this.hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / this.window)
		}

		// What one segment needs held at once, twice over so a push can append while a segment is pending.
		const capacity = nextPowerOfTwo(2 * (Math.ceil(this.analysisHop) + 2 * this.tolerance + 2 * this.window) + 1024)

		this.mask = capacity - 1
		this.ring = Array.from({ length: channels }, () => new Float32Array(capacity))
		this.mono = new Float32Array(capacity)
		this.accumulator = Array.from({ length: channels }, () => new Float32Array(this.window))
		this.template = new Float32Array(this.hop)
		this.region = new Float32Array(2 * this.tolerance + this.hop + 1)
		this.staging = Array.from({ length: channels }, () => new Float32Array(Math.max(4096, this.hop * 8)))
	}

	public push(planar: readonly Float32Array[]): Float32Array[] {
		if (this.flushed) {
			throw new Error("time stretch already flushed")
		}

		const length = checkPlanar(planar, this.channels)
		const capacity = this.mask + 1
		let offset = 0

		while (offset < length) {
			const take = Math.min(capacity - (this.inEnd - this.inStart), length - offset)

			this.append(planar, offset, take)
			offset += take
			this.process(false)
		}

		return this.drain()
	}

	public flush(): Float32Array[] {
		if (this.flushed) {
			return emptyOutput(this.channels)
		}

		this.flushed = true
		this.process(true)

		return this.drain()
	}

	private target(): number {
		return Math.round(this.inEnd / this.speed)
	}

	private append(planar: readonly Float32Array[], offset: number, count: number): void {
		const mask = this.mask
		const scale = 1 / this.channels

		for (let i = 0; i < count; i++) {
			this.mono[(this.inEnd + i) & mask] = 0
		}

		for (const [c, ring] of this.ring.entries()) {
			const source = channelAt(planar, c)

			for (let i = 0; i < count; i++) {
				const at = (this.inEnd + i) & mask
				const value = source[offset + i] ?? 0

				ring[at] = value
				this.mono[at] = (this.mono[at] ?? 0) + value * scale
			}
		}

		this.inEnd += count
	}

	private monoAt(index: number): number {
		return index < this.inStart || index >= this.inEnd ? 0 : (this.mono[index & this.mask] ?? 0)
	}

	private sampleAt(channel: Float32Array, index: number): number {
		return index < this.inStart || index >= this.inEnd ? 0 : (channel[index & this.mask] ?? 0)
	}

	// Lays down every segment the held input allows (all of them, zero-padded, once the stream has ended).
	private process(final: boolean): void {
		for (;;) {
			const nominal = Math.round(this.frame * this.analysisHop)

			if (final ? this.emitted >= this.target() : this.inEnd < nominal + this.tolerance + this.window) {
				return
			}

			const position = this.previous < 0 ? 0 : this.bestPosition(nominal)

			this.overlapAdd(position)
			// The stream's end cuts the last hop to the exact output length.
			this.emit(final ? Math.min(this.hop, this.target() - this.emitted) : this.hop)
			this.previous = position
			this.frame++

			// Nothing before the next template or the next search window is read again.
			const keep = Math.min(position + this.hop, Math.round(this.frame * this.analysisHop) - this.tolerance)

			if (keep > this.inStart) {
				this.inStart = Math.min(keep, this.inEnd)
			}
		}
	}

	// The input position within the tolerance of `nominal` whose segment continues the previous one best.
	private bestPosition(nominal: number): number {
		const low = Math.max(this.inStart, nominal - this.tolerance)
		const high = Math.max(low, nominal + this.tolerance)
		const hop = this.hop
		const template = this.template
		const region = this.region
		const continuation = this.previous + hop

		for (let n = 0; n < hop; n++) {
			template[n] = this.monoAt(continuation + n)
		}

		const span = high - low + hop

		for (let n = 0; n < span; n++) {
			region[n] = this.monoAt(low + n)
		}

		let best = low
		let bestScore = -Infinity

		for (let p = low; p <= high; p += this.coarseStep) {
			const score = this.similarity(p - low, DECIMATION)

			if (score > bestScore) {
				bestScore = score
				best = p
			}
		}

		const coarse = best
		const from = Math.max(low, coarse - this.coarseStep + 1)
		const to = Math.min(high, coarse + this.coarseStep - 1)

		for (let p = from; p <= to; p++) {
			if (p === coarse) {
				continue
			}

			const score = this.similarity(p - low, 1)

			if (score > bestScore) {
				bestScore = score
				best = p
			}
		}

		// The refined candidates are scored at full resolution, the coarse winner at a decimated one: settle
		// between them on equal terms.
		if (best !== coarse && this.similarity(coarse - low, 1) >= bestScore) {
			best = coarse
		}

		return best
	}

	// Normalised cross-correlation of the template with the region at `offset`, every `step`-th sample.
	private similarity(offset: number, step: number): number {
		const template = this.template
		const region = this.region
		let dot = 0
		let energy = 1e-9

		for (let n = 0; n < this.hop; n += step) {
			const value = region[offset + n] ?? 0

			dot += (template[n] ?? 0) * value
			energy += value * value
		}

		return dot / Math.sqrt(energy)
	}

	private overlapAdd(position: number): void {
		const first = this.previous < 0

		for (const [c, channel] of this.ring.entries()) {
			const accumulator = channelAt(this.accumulator, c)

			for (let n = 0; n < this.window; n++) {
				// Nothing overlaps the first segment's rising half: taken at full weight, so the start is not faded in.
				const weight = first && n < this.hop ? 1 : (this.hann[n] ?? 0)

				accumulator[n] = (accumulator[n] ?? 0) + weight * this.sampleAt(channel, position + n)
			}
		}
	}

	// Moves the first `count` (≤ hop) accumulated samples, now final, to the staging area.
	private emit(count: number): void {
		this.ensureStaging(this.staged + count)

		for (const [c, accumulator] of this.accumulator.entries()) {
			const staging = channelAt(this.staging, c)

			staging.set(accumulator.subarray(0, count), this.staged)
			accumulator.copyWithin(0, this.hop)
			accumulator.fill(0, this.window - this.hop)
		}

		this.staged += count
		this.emitted += count
	}

	private ensureStaging(length: number): void {
		const current = this.staging[0]?.length ?? 0

		if (length <= current) {
			return
		}

		const grown = nextPowerOfTwo(length)

		this.staging = this.staging.map(old => {
			const next = new Float32Array(grown)

			next.set(old.subarray(0, this.staged))

			return next
		})
	}

	private drain(): Float32Array[] {
		const out = this.staging.map(channel => channel.slice(0, this.staged))

		this.staged = 0

		return out
	}
}
