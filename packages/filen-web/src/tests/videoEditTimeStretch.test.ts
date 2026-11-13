import { describe, expect, it } from "vitest"
import { createTimeStretch } from "@/features/preview/videoEdit/audio/timeStretch"

const RATE = 48_000

function sine(frequency: number, seconds: number, amplitude = 0.5, rate = RATE): Float32Array {
	const out = new Float32Array(Math.round(seconds * rate))

	for (let i = 0; i < out.length; i++) {
		out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate)
	}

	return out
}

function concat(parts: readonly Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// Feeds `input` (planar) in chunks of the given sizes, cycling, and returns the whole output per channel.
function stretch(input: readonly Float32Array[], speed: number, chunks: readonly number[], rate = RATE): Float32Array[] {
	const stretcher = createTimeStretch(rate, input.length, speed)
	const outputs: Float32Array[][] = input.map(() => [])
	const length = input[0]?.length ?? 0
	let at = 0
	let turn = 0

	while (at < length) {
		const size = Math.min(chunks[turn % chunks.length] ?? 1024, length - at)
		const result = stretcher.push(input.map(channel => channel.subarray(at, at + size)))

		result.forEach((channel, c) => outputs[c]?.push(channel))
		at += size
		turn++
	}

	stretcher.flush().forEach((channel, c) => outputs[c]?.push(channel))

	return outputs.map(concat)
}

// Frequency from upward zero crossings with linear interpolation, over [from, to).
function frequencyOf(signal: Float32Array, from: number, to: number, rate = RATE): number {
	const crossings: number[] = []

	for (let i = from + 1; i < to; i++) {
		const a = signal[i - 1] ?? 0
		const b = signal[i] ?? 0

		if (a < 0 && b >= 0) {
			crossings.push(i - 1 + a / (a - b))
		}
	}

	const first = crossings[0] ?? 0
	const last = crossings[crossings.length - 1] ?? 0

	return ((crossings.length - 1) * rate) / (last - first)
}

function maxStep(signal: Float32Array): number {
	let max = 0

	for (let i = 1; i < signal.length; i++) {
		max = Math.max(max, Math.abs((signal[i] ?? 0) - (signal[i - 1] ?? 0)))
	}

	return max
}

function rms(signal: Float32Array, from: number, to: number): number {
	let sum = 0

	for (let i = from; i < to; i++) {
		sum += (signal[i] ?? 0) ** 2
	}

	return Math.sqrt(sum / (to - from))
}

describe("createTimeStretch", () => {
	for (const speed of [0.25, 0.5, 0.8, 1.5, 2, 4]) {
		it(`scales the duration by 1/${String(speed)} and keeps a 440 Hz tone at 440 Hz`, () => {
			const input = sine(440, 2)
			const [output = new Float32Array(0)] = stretch([input], speed, [1000, 4096, 333, 9000])

			expect(output.length).toBe(Math.round(input.length / speed))

			const quarter = Math.floor(output.length / 4)
			const frequency = frequencyOf(output, quarter, output.length - quarter)

			expect(Math.abs(frequency - 440) / 440).toBeLessThan(0.01)
		})
	}

	it("has no clicks: no sample step beyond the tone's own steepest slope, across chunk joins", () => {
		const amplitude = 0.5
		const input = sine(440, 1.5, amplitude)
		// The steepest step of the sine itself.
		const slope = (amplitude * 2 * Math.PI * 440) / RATE

		for (const speed of [0.5, 2, 3.3]) {
			const [output = new Float32Array(0)] = stretch([input], speed, [777, 128, 5000])

			expect(maxStep(output)).toBeLessThan(slope * 1.5)
		}
	})

	it("keeps the level steady (no dips where segments overlap) and starts without a fade-in", () => {
		const input = sine(220, 2)
		const [output = new Float32Array(0)] = stretch([input], 1.7, [2048])
		const window = 4800

		for (let from = window; from + window < output.length - window; from += window) {
			expect(rms(output, from, from + window)).toBeGreaterThan(0.5 / Math.SQRT2 - 0.02)
			expect(rms(output, from, from + window)).toBeLessThan(0.5 / Math.SQRT2 + 0.02)
		}

		// The first samples are the input's own.
		for (let i = 0; i < 100; i++) {
			expect(output[i]).toBeCloseTo(input[i] ?? 0, 6)
		}
	})

	it("gives the same output however the input is chunked", () => {
		const input = concat([sine(330, 0.7), sine(550, 0.6, 0.3)])
		const [a = new Float32Array(0)] = stretch([input], 1.3, [48_000])
		const [b = new Float32Array(0)] = stretch([input], 1.3, [17, 4000, 1])

		expect(b).toEqual(a)
	})

	it("moves every channel by the same segment choice and keeps each one's pitch", () => {
		const left = sine(440, 1.5)
		const right = sine(660, 1.5, 0.25)
		const [outLeft = new Float32Array(0), outRight = new Float32Array(0)] = stretch([left, right], 2, [3000])

		expect(outLeft.length).toBe(outRight.length)
		expect(outLeft.length).toBe(Math.round(left.length / 2))

		const quarter = Math.floor(outLeft.length / 4)

		expect(Math.abs(frequencyOf(outLeft, quarter, outLeft.length - quarter) - 440) / 440).toBeLessThan(0.01)
		expect(Math.abs(frequencyOf(outRight, quarter, outRight.length - quarter) - 660) / 660).toBeLessThan(0.015)
	})

	it("works at other sample rates", () => {
		const rate = 44_100
		const input = sine(500, 1, 0.5, rate)
		const [output = new Float32Array(0)] = stretch([input], 0.5, [1024], rate)

		expect(output.length).toBe(Math.round(input.length / 0.5))

		const quarter = Math.floor(output.length / 4)

		expect(Math.abs(frequencyOf(output, quarter, output.length - quarter, rate) - 500) / 500).toBeLessThan(0.01)
	})

	it("passes speed 1 through as copies", () => {
		const input = sine(440, 0.1)
		const stretcher = createTimeStretch(RATE, 1, 1)
		const [output] = stretcher.push([input])

		expect(output).toEqual(input)
		expect(output).not.toBe(input)
		expect(stretcher.flush()[0]?.length).toBe(0)
	})

	it("rejects speeds outside 0.25..4 and mismatched channels", () => {
		expect(() => createTimeStretch(RATE, 1, 0.2)).toThrow(RangeError)
		expect(() => createTimeStretch(RATE, 1, 4.5)).toThrow(RangeError)
		expect(() => createTimeStretch(RATE, 1, Number.NaN)).toThrow(RangeError)
		expect(() => createTimeStretch(RATE, 2, 2).push([new Float32Array(4)])).toThrow(RangeError)
		expect(() => createTimeStretch(RATE, 2, 2).push([new Float32Array(4), new Float32Array(5)])).toThrow(RangeError)
	})

	it("refuses input after the flush, and a second flush is empty", () => {
		const stretcher = createTimeStretch(RATE, 1, 2)

		stretcher.push([sine(440, 0.2)])
		stretcher.flush()

		expect(stretcher.flush()[0]?.length).toBe(0)
		expect(() => stretcher.push([new Float32Array(10)])).toThrow()
	})

	it("handles a stream shorter than one segment", () => {
		const input = sine(440, 0.01)
		const [output = new Float32Array(0)] = stretch([input], 0.5, [100])

		expect(output.length).toBe(Math.round(input.length / 0.5))
	})
})
