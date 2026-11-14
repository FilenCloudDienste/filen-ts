// A track's smart edges from the loudness envelope of its first and last seconds: where its audio starts past
// leading silence, where it stops before trailing silence, and where a long fade-out begins. The envelope is the
// mean square of each 50 ms window, the loudest channel's, so about 600 floats describe a whole analysis.

export const ENVELOPE_WINDOW_MS = 50

// The windows analysed, and the byte budget past which only the boundary windows are read.
export const EDGE_WINDOWS = {
	headSeconds: 10,
	tailSeconds: 20,
	// The level of the first and last second, which an album's track boundary is judged by: always read.
	boundarySeconds: 1,
	maxWindowBytes: 16 * 1024 * 1024
} as const

export type EdgeWindows = { readonly [K in keyof typeof EDGE_WINDOWS]: number }

// A window quieter than this is silence.
export const SILENCE_DB = -60

// Leading silence skipped at most.
export const MAX_IN_START_MS = 10_000

// A fade-out: from its start on, every window lies this far below the tail's reference level (the given
// percentile of its audible windows) and the smoothed level never rises by more than the tolerance.
export const FADE_DROP_DB = 12
export const FADE_RISE_TOLERANCE_DB = 2
export const FADE_REFERENCE_PERCENTILE = 0.9
export const FADE_SMOOTHING_MS = 1000
// A fade-out starts this far into the tail window at the earliest: one longer than the window is clamped there.
export const FADE_MIN_TAIL_OFFSET_MS = 2000

// Digital silence in dB: finite, so it survives JSON.
const FLOOR_DB = -120

export function powerDb(meanSquare: number): number {
	return meanSquare > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(meanSquare)) : FLOOR_DB
}

export function windowsFor(seconds: number): number {
	return Math.ceil((seconds * 1000) / ENVELOPE_WINDOW_MS)
}

// The running envelope: finished windows, plus the sums of the window still open (per channel) and its frames.
export interface Envelope {
	power: Float32Array
	length: number
	partial: Float64Array
	partialFrames: number
}

export function createEnvelope(capacity: number): Envelope {
	return { power: new Float32Array(Math.max(1, capacity)), length: 0, partial: new Float64Array(2), partialFrames: 0 }
}

function windowFrames(sampleRate: number): number {
	return Math.max(1, Math.round((sampleRate * ENVELOPE_WINDOW_MS) / 1000))
}

// Adds `frames` frames of audio: `plane(c)` returns channel c's samples (at least `frames` of them), read before
// the next plane is asked for, so one scratch buffer can serve every channel. A window may span calls.
export function accumulateEnvelope(
	envelope: Envelope,
	channels: number,
	frames: number,
	sampleRate: number,
	plane: (channel: number) => Float32Array
): void {
	if (frames <= 0 || channels <= 0) {
		return
	}

	const size = windowFrames(sampleRate)
	const open = envelope.partialFrames
	const completed = Math.floor((open + frames) / size)
	const base = envelope.length

	if (base + completed > envelope.power.length) {
		const grown = new Float32Array(Math.max(base + completed, envelope.power.length * 2))

		grown.set(envelope.power.subarray(0, base))
		envelope.power = grown
	}

	if (envelope.partial.length < channels) {
		const grown = new Float64Array(channels)

		grown.set(envelope.partial)
		envelope.partial = grown
	}

	envelope.power.fill(0, base, base + completed)

	for (let channel = 0; channel < channels; channel++) {
		const data = plane(channel)
		let sum = envelope.partial[channel] ?? 0
		let i = 0

		for (let window = 0; window < completed; window++) {
			const end = i + (window === 0 ? size - open : size)

			for (; i < end; i++) {
				const value = data[i] ?? 0

				sum += value * value
			}

			const meanSquare = sum / size

			if (meanSquare > (envelope.power[base + window] ?? 0)) {
				envelope.power[base + window] = meanSquare
			}

			sum = 0
		}

		for (; i < frames; i++) {
			const value = data[i] ?? 0

			sum += value * value
		}

		envelope.partial[channel] = sum
	}

	// A channel the stream no longer carries leaves nothing in the open window.
	envelope.partial.fill(0, channels)
	envelope.length = base + completed
	envelope.partialFrames = open + frames - completed * size
}

// The finished envelope; a last open window counts when it holds half a window or more.
export function finishEnvelope(envelope: Envelope, sampleRate: number): Float32Array {
	const open = envelope.partialFrames

	if (open * 2 >= windowFrames(sampleRate) && open > 0) {
		let loudest = 0

		for (const sum of envelope.partial) {
			loudest = Math.max(loudest, sum / open)
		}

		if (envelope.length >= envelope.power.length) {
			const grown = new Float32Array(envelope.length + 1)

			grown.set(envelope.power)
			envelope.power = grown
		}

		envelope.power[envelope.length] = loudest
		envelope.length++
	}

	envelope.partial.fill(0)
	envelope.partialFrames = 0

	return envelope.power.subarray(0, envelope.length)
}

export interface FoundEdges {
	inStartMs: number | null
	outEndFromEndMs: number | null
	fadeOutFromEndMs: number | null
}

function isAudible(meanSquare: number): boolean {
	return powerDb(meanSquare) >= SILENCE_DB
}

// `head` starts at the track's start, `tail` ends at its end; null for a tail that could not be read.
export function findEdges(head: Float32Array, tail: Float32Array | null): FoundEdges {
	return { inStartMs: inStart(head), ...outEdges(tail) }
}

function inStart(head: Float32Array): number | null {
	if (head.length === 0) {
		return null
	}

	let first = head.findIndex(isAudible)

	if (first === -1) {
		first = head.length
	}

	return Math.min(MAX_IN_START_MS, Math.max(0, (first - 1) * ENVELOPE_WINDOW_MS))
}

function outEdges(tail: Float32Array | null): Omit<FoundEdges, "inStartMs"> {
	const none = { outEndFromEndMs: null, fadeOutFromEndMs: null }

	if (tail === null) {
		return none
	}

	let last = tail.length - 1

	while (last >= 0 && !isAudible(tail[last] ?? 0)) {
		last--
	}

	// A silent tail hides what lies before it: nothing is skipped.
	if (last < 0) {
		return none
	}

	const n = tail.length
	const fade = fadeOutStart(tail, last)

	return {
		outEndFromEndMs: Math.max(0, (n - 2 - last) * ENVELOPE_WINDOW_MS),
		fadeOutFromEndMs: fade === null ? null : (n - fade) * ENVELOPE_WINDOW_MS
	}
}

// The earliest window, at least FADE_MIN_TAIL_OFFSET_MS into the tail, from which the level stays FADE_DROP_DB
// below the reference and (smoothed) keeps falling up to the last audible window. Since a later start only
// weakens both conditions, the windows that qualify run without a gap to the end: scanned back from it.
function fadeOutStart(tail: Float32Array, last: number): number | null {
	const earliest = Math.ceil(FADE_MIN_TAIL_OFFSET_MS / ENVELOPE_WINDOW_MS)

	if (last < earliest) {
		return null
	}

	const audible: number[] = []

	for (let i = 0; i <= last; i++) {
		const value = tail[i] ?? 0

		if (isAudible(value)) {
			audible.push(powerDb(value))
		}
	}

	audible.sort((a, b) => a - b)

	const reference = audible[Math.min(audible.length - 1, Math.floor(FADE_REFERENCE_PERCENTILE * (audible.length - 1)))] ?? FLOOR_DB
	const ceiling = reference - FADE_DROP_DB
	const smoothed = smoothedDb(tail, last)
	let start: number | null = null
	let laterMax = Number.NEGATIVE_INFINITY

	for (let k = last; k >= earliest; k--) {
		const level = smoothed[k] ?? FLOOR_DB

		if (powerDb(tail[k] ?? 0) > ceiling || laterMax > level + FADE_RISE_TOLERANCE_DB) {
			break
		}

		start = k
		laterMax = Math.max(laterMax, level)
	}

	return start
}

// Each window's level over the FADE_SMOOTHING_MS around it, up to `last`.
function smoothedDb(tail: Float32Array, last: number): Float32Array {
	const half = Math.floor(FADE_SMOOTHING_MS / ENVELOPE_WINDOW_MS / 2)
	const sums = new Float64Array(last + 2)

	for (let i = 0; i <= last; i++) {
		sums[i + 1] = (sums[i] ?? 0) + (tail[i] ?? 0)
	}

	const out = new Float32Array(last + 1)

	for (let i = 0; i <= last; i++) {
		const from = Math.max(0, i - half)
		const to = Math.min(last, i + half - 1)

		out[i] = powerDb(((sums[to + 1] ?? 0) - (sums[from] ?? 0)) / (to - from + 1))
	}

	return out
}

// The level of the first and last `seconds` of the track, in dBFS; null without a tail.
export function findBoundaryLevels(
	head: Float32Array,
	tail: Float32Array | null,
	seconds: number
): { headDb: number; tailDb: number } | null {
	if (tail === null || head.length === 0 || tail.length === 0) {
		return null
	}

	const windows = windowsFor(seconds)

	return { headDb: meanDb(head.subarray(0, windows)), tailDb: meanDb(tail.subarray(Math.max(0, tail.length - windows))) }
}

function meanDb(windows: Float32Array): number {
	let sum = 0

	for (const value of windows) {
		sum += value
	}

	return powerDb(sum / windows.length)
}
