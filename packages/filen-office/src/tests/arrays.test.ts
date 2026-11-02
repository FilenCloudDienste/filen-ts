import { describe, expect, it } from "vitest"
import { appendAll, fromCharCodes, fromCodePoints, maxOf, minOf, spliceAll } from "../core/arrays"
import { budget, cpuMs } from "./timing"

// The helpers for content-sized input do what the spread call they replace does, and take more items than a call
// takes arguments.

const MANY = 300_000

function random(seed: number): () => number {
	let state = seed

	return () => {
		state = (state * 1_103_515_245 + 12_345) >>> 0

		return state / 0x1_0000_0000
	}
}

describe("appendAll", () => {
	it("appends in order, more items than a call takes", () => {
		const target = [-1]
		const items = Array.from({ length: MANY }, (_, k) => k)

		appendAll(target, items)

		expect(target.length).toBe(MANY + 1)
		expect(target[0]).toBe(-1)
		expect(target[MANY]).toBe(MANY - 1)
	})
})

describe("appendAll onto itself", () => {
	it("appends the items as they were, as push(...a) does", () => {
		const target = [1, 2, 3]

		appendAll(target, target)

		expect(target).toEqual([1, 2, 3, 1, 2, 3])
	})
})

describe("spliceAll", () => {
	it("is splice with the items spread, for any start and count", () => {
		const next = random(7)

		for (let run = 0; run < 2000; run++) {
			const length = Math.floor(next() * 8)
			const base = Array.from({ length }, (_, k) => k)
			const start = Math.floor(next() * 14) - 7
			const count = Math.floor(next() * 5)
			const items = Array.from({ length: Math.floor(next() * 4) }, (_, k) => 100 + k)
			const expected = [...base]
			const expectedRemoved = expected.splice(start, count, ...items)
			const actual = [...base]

			expect(spliceAll(actual, start, count, items)).toEqual(expectedRemoved)
			expect(actual).toEqual(expected)
		}
	})

	it("inserts the target's own items as they were", () => {
		const target = [1, 2, 3]
		const expected = [1, 2, 3]

		expected.splice(1, 1, ...expected)

		expect(spliceAll(target, 1, 1, target)).toEqual([2])
		expect(target).toEqual(expected)
	})

	it("takes a fractional start and count as splice does", () => {
		for (const [start, count] of [
			[-1.5, 1],
			[1.7, 1.2],
			[-0.5, 2],
			[Number.NaN, 1]
		] as const) {
			const expected = [0, 1, 2, 3]
			const removed = expected.splice(start, count, 9)
			const actual = [0, 1, 2, 3]

			expect(spliceAll(actual, start, count, [9])).toEqual(removed)
			expect(actual).toEqual(expected)
		}
	})

	it("splices a few items into a large array at a native splice's cost", () => {
		const target = Array.from({ length: 1_000_000 }, (_, k) => k)
		const start = cpuMs()

		for (let k = 0; k < 200; k++) spliceAll(target, 10 + k, 1, [k, k])

		expect(target.length).toBe(1_000_200)
		expect(cpuMs() - start).toBeLessThan(budget(400))
	})

	it("inserts more items than a call takes, in one pass over the tail", () => {
		const target = Array.from({ length: 1_000_000 }, (_, k) => k)
		const start = cpuMs()

		for (let k = 0; k < 20; k++) spliceAll(target, 10, 2, new Array<number>(MANY).fill(-1))

		expect(target.length).toBe(1_000_000 + 20 * (MANY - 2))
		expect(target[10]).toBe(-1)
		expect(target[target.length - 1]).toBe(999_999)
		expect(cpuMs() - start).toBeLessThan(budget(4000))
	})

	it("inserts more items than a call takes", () => {
		const target = [1, 2]

		spliceAll(target, 1, 0, new Array<number>(MANY).fill(0))

		expect(target.length).toBe(MANY + 2)
		expect(target[0]).toBe(1)
		expect(target[MANY + 1]).toBe(2)
	})
})

describe("maxOf and minOf", () => {
	it("are Math.max and Math.min", () => {
		const cases: number[][] = [[], [1], [3, -2, 7], [Number.NaN, 1], [0, -0], [-0, 0], [-Infinity], [Infinity, -Infinity]]

		for (const values of cases) {
			expect(Object.is(maxOf(values), Math.max(...values))).toBe(true)
			expect(Object.is(minOf(values), Math.min(...values))).toBe(true)
		}
	})

	it("take more values than a call takes", () => {
		const values = Array.from({ length: MANY }, (_, k) => (k * 7919) % MANY)

		expect(maxOf(values)).toBe(MANY - 1)
		expect(minOf(values)).toBe(0)
	})
})

describe("fromCharCodes and fromCodePoints", () => {
	it("are String.fromCharCode and fromCodePoint, from arrays and typed arrays", () => {
		const units = [0x48, 0x69, 0xd83d, 0xde00, 0]

		expect(fromCharCodes(units)).toBe(String.fromCharCode(...units))
		expect(fromCharCodes(new Uint16Array(units))).toBe(String.fromCharCode(...units))
		expect(fromCharCodes(new Uint8Array([0x41, 0xff]))).toBe("Aÿ")
		expect(fromCodePoints([0x1f600, 0x41])).toBe("\u{1f600}A")
		expect(fromCodePoints(new Uint32Array([0x10ffff]))).toBe(String.fromCodePoint(0x10ffff))
	})

	it("take more units than a call takes", () => {
		const units = new Uint8Array(MANY).fill(0x61)
		const points = new Array<number>(MANY).fill(0x1f600)

		expect(fromCharCodes(units)).toBe("a".repeat(MANY))
		expect(fromCharCodes([...units])).toBe("a".repeat(MANY))
		expect(fromCodePoints(points)).toBe("\u{1f600}".repeat(MANY))
	})
})
