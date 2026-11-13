import { describe, expect, it } from "vitest"
import {
	accessAtOrBefore,
	fragmentEnd,
	lastMoof,
	locateSample,
	parseMfra,
	parseTfra,
	type FragmentRandomAccess
} from "@filen/shared/videos"

// Hand-built fragment boxes for the layouts mediabunny never writes (version-0 tfra with short numbers,
// several truns, trex fallbacks, a second traf without a base); the mediabunny round trip lives in
// filen-web's videoProbeFragmented.test.ts.

function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function box(type: string, ...content: (number[] | Uint8Array)[]): Uint8Array {
	const body = content.flatMap(part => Array.from(part))
	const size = 8 + body.length

	return Uint8Array.from([...u32(size), ...Array.from(type, char => char.charCodeAt(0)), ...body])
}

function fullBox(type: string, version: number, flags: number, ...content: (number[] | Uint8Array)[]): Uint8Array {
	return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...content)
}

function payload(bytes: Uint8Array): [Uint8Array, number, number] {
	return [bytes, 8, bytes.length]
}

describe("tfra", () => {
	it("reads version 0 entries with one-, two- and three-byte numbers", () => {
		// traf numbers 1 byte, trun 2 bytes, sample 3 bytes: lengths 0b00_01_10.
		const tfra = fullBox(
			"tfra",
			0,
			0,
			u32(3),
			u32(0b000110),
			u32(2),
			[...u32(0), ...u32(100), 1, 0, 1, 0, 0, 1],
			[...u32(4800), ...u32(9000), 2, 0, 3, 0, 1, 2]
		)
		const access = parseTfra(...payload(tfra))

		expect(access?.track).toBe(3)
		expect(Array.from(access?.times ?? [])).toEqual([0, 4800])
		expect(Array.from(access?.moofs ?? [])).toEqual([100, 9000])
		expect(Array.from(access?.trafs ?? [])).toEqual([1, 2])
		expect(Array.from(access?.truns ?? [])).toEqual([1, 3])
		expect(Array.from(access?.samples ?? [])).toEqual([1, 258])
		expect(access?.ordered).toBe(true)
	})

	it("refuses entries that overrun the box, and skips them inside an mfra", () => {
		const tfra = fullBox("tfra", 1, 0, u32(1), u32(0), u32(50), new Array<number>(27).fill(0))

		expect(parseTfra(...payload(tfra))).toBeNull()

		const good = fullBox("tfra", 0, 0, u32(2), u32(0), u32(1), [...u32(0), ...u32(8), 1, 1, 1])
		const mfra = box("mfra", tfra, good, fullBox("mfro", 0, 0, u32(0)))

		expect([...parseMfra(...payload(mfra)).keys()]).toEqual([2])
	})
})

function access(times: number[], moofs: number[]): FragmentRandomAccess {
	return {
		track: 1,
		times: Float64Array.from(times),
		moofs: Float64Array.from(moofs),
		trafs: new Uint32Array(times.length).fill(1),
		truns: new Uint32Array(times.length).fill(1),
		samples: new Uint32Array(times.length).fill(1),
		ordered: times.every((time, i) => i === 0 || time >= (times[i - 1] ?? 0))
	}
}

describe("random access lookups", () => {
	it("finds the last keyframe at or before a time, or the first", () => {
		const ordered = access([0, 100, 200, 300], [10, 20, 30, 40])

		expect(accessAtOrBefore(ordered, -5)).toBe(0)
		expect(accessAtOrBefore(ordered, 99)).toBe(0)
		expect(accessAtOrBefore(ordered, 100)).toBe(1)
		expect(accessAtOrBefore(ordered, 1e9)).toBe(3)
		expect(accessAtOrBefore(access([], []), 5)).toBe(-1)
	})

	it("scans an index whose times are out of order", () => {
		const shuffled = access([200, 0, 300, 100], [30, 10, 40, 20])

		expect(shuffled.ordered).toBe(false)
		expect(accessAtOrBefore(shuffled, 150)).toBe(3)
		expect(accessAtOrBefore(shuffled, -1)).toBe(1)
	})

	it("takes the latest moof over every track", () => {
		expect(
			lastMoof(
				new Map([
					[1, access([0, 1], [10, 500])],
					[2, access([0], [900])]
				])
			)
		).toBe(900)
		expect(lastMoof(new Map())).toBeNull()
	})
})

const TFHD_BASE_IS_MOOF = 0x20000

// A moof of two trafs: track 1 (defaults from tfhd, default-base-is-moof) with two truns, the second without
// a data offset; track 2 with no base and no flag, so its data cannot be placed.
function moof(): Uint8Array {
	const traf1 = box(
		"traf",
		fullBox("tfhd", 0, TFHD_BASE_IS_MOOF | 0x8, u32(1), u32(512)),
		fullBox("tfdt", 1, 0, u32(0), u32(90_000)),
		// data offset, sizes per sample.
		fullBox("trun", 0, 0x1 | 0x200, u32(2), u32(300), u32(10), u32(20)),
		fullBox("trun", 0, 0x200, u32(2), u32(30), u32(40))
	)
	const traf2 = box(
		"traf",
		fullBox("tfhd", 0, 0, u32(2)),
		fullBox("tfdt", 0, 0, u32(48_000)),
		fullBox("trun", 0, 0x1 | 0x100, u32(3), u32(400), u32(1024), u32(1024), u32(1024))
	)

	return box("moof", fullBox("mfhd", 0, 0, u32(1)), traf1, traf2)
}

describe("moof", () => {
	const index = {
		defaults: new Map([[2, { duration: 1024, size: 7 }]]),
		timescales: new Map([
			[1, 90_000],
			[2, 48_000]
		])
	}

	it("places samples across truns, the second following on from the first", () => {
		const bytes = moof()

		expect(locateSample(bytes, 5000, { track: 1, traf: 1, trun: 1, sample: 1 }, undefined)).toEqual({ offset: 5300, size: 10 })
		expect(locateSample(bytes, 5000, { track: 1, traf: 1, trun: 1, sample: 2 }, undefined)).toEqual({ offset: 5310, size: 20 })
		expect(locateSample(bytes, 5000, { track: 1, traf: 1, trun: 2, sample: 2 }, undefined)).toEqual({ offset: 5360, size: 40 })
	})

	it("refuses what the moof does not hold as the index said", () => {
		const bytes = moof()

		// Wrong track for the traf, a sample past the run, a traf whose data has no base.
		expect(locateSample(bytes, 0, { track: 2, traf: 1, trun: 1, sample: 1 }, undefined)).toBeNull()
		expect(locateSample(bytes, 0, { track: 1, traf: 1, trun: 1, sample: 3 }, undefined)).toBeNull()
		expect(locateSample(bytes, 0, { track: 2, traf: 2, trun: 1, sample: 1 }, { duration: 0, size: 7 })).toBeNull()
		expect(locateSample(bytes, 0, { track: 1, traf: 3, trun: 1, sample: 1 }, undefined)).toBeNull()
	})

	it("ends where the latest track's samples end", () => {
		// Track 1: 90000 + 4 * 512 ticks at 90 kHz; track 2: 48000 + 3 * 1024 at 48 kHz.
		expect(fragmentEnd(moof(), index)).toBeCloseTo(Math.max((90_000 + 2048) / 90_000, (48_000 + 3072) / 48_000), 9)
	})

	it("falls back to trex durations, and skips tracks it cannot time", () => {
		const bytes = box(
			"moof",
			box("traf", fullBox("tfhd", 0, 0, u32(2)), fullBox("tfdt", 0, 0, u32(0)), fullBox("trun", 0, 0, u32(10))),
			box("traf", fullBox("tfhd", 0, 0, u32(9)), fullBox("tfdt", 0, 0, u32(0)), fullBox("trun", 0, 0, u32(10)))
		)

		expect(fragmentEnd(bytes, index)).toBeCloseTo(10_240 / 48_000, 9)
		expect(fragmentEnd(bytes, { defaults: new Map(), timescales: index.timescales })).toBeNull()
	})
})
