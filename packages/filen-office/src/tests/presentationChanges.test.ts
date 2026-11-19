import { describe, expect, it } from "vitest"
import { movedShapes } from "../core/presentation/edit/changes"
import { budget, cpuMs } from "./timing"

// The length of a longest common subsequence, by the full table (small inputs only).
function lcsLength(a: readonly number[], b: readonly number[]): number {
	let row = new Array<number>(b.length + 1).fill(0)

	for (const x of a) {
		const next = new Array<number>(b.length + 1).fill(0)

		for (let j = 0; j < b.length; j++)
			next[j + 1] = x === b[j] ? (row[j] as number) + 1 : Math.max(row[j + 1] as number, next[j] as number)

		row = next
	}

	return row[b.length] as number
}

// `moved` leaves the others of `now` (those also in `saved`) in their saved relative order.
function keepsOrder(saved: readonly number[], now: readonly number[], moved: readonly number[]): boolean {
	const kept = new Set(saved)
	const out = new Set(moved)
	const rest = now.filter(id => kept.has(id) && !out.has(id))
	const index = new Map(saved.map((id, i) => [id, i]))

	return rest.every((id, i) => i === 0 || (index.get(rest[i - 1] as number) as number) < (index.get(id) as number))
}

describe("movedShapes", () => {
	it("reports nothing for an unchanged order", () => {
		expect(movedShapes([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toEqual([])
	})

	it("reports the one shape moved", () => {
		expect(movedShapes([1, 2, 3, 4, 5], [1, 4, 2, 3, 5])).toEqual([4])
		expect(movedShapes([1, 2, 3, 4, 5], [5, 1, 2, 3, 4])).toEqual([5])
		expect(movedShapes([1, 2, 3, 4, 5], [2, 3, 4, 5, 1])).toEqual([1])
	})

	it("ignores inserted and deleted shapes", () => {
		expect(movedShapes([1, 2, 3, 4], [1, 9, 3, 4, 8])).toEqual([])
		expect(movedShapes([1, 2, 3, 4, 5], [7, 5, 1, 3, 6])).toEqual([5])
		expect(movedShapes([], [1, 2])).toEqual([])
		expect(movedShapes([1, 2], [])).toEqual([])
	})

	it("keeps one shape of a reversed order", () => {
		const moved = movedShapes([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])

		expect(moved).toHaveLength(4)
		expect(keepsOrder([1, 2, 3, 4, 5], [5, 4, 3, 2, 1], moved)).toBe(true)
	})

	it("moves as few shapes as a longest common subsequence allows", () => {
		let seed = 7

		const random = (limit: number): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648

			return seed % limit
		}

		for (let round = 0; round < 300; round++) {
			const saved = Array.from({ length: random(30) }, (_, i) => i + 1)
			const now = saved.filter(() => random(5) !== 0)

			for (let swap = random(6); swap > 0 && now.length > 1; swap--) {
				const from = random(now.length)
				const [id] = now.splice(from, 1)

				now.splice(random(now.length + 1), 0, id as number)
			}

			for (let insert = random(3); insert > 0; insert--) now.splice(random(now.length + 1), 0, 100 + round * 10 + insert)

			const moved = movedShapes(saved, now)
			const common = now.filter(id => saved.includes(id)).length

			expect(moved.length).toBe(common - lcsLength(saved, now))
			expect(keepsOrder(saved, now, moved)).toBe(true)
		}
	})

	it("handles 20,000 siblings in linear-ish time and memory", () => {
		const saved = Array.from({ length: 20_000 }, (_, i) => i + 1)
		const now = [...saved].reverse()
		const local = [...saved]

		local.splice(10_000, 0, 50_000)
		local.splice(500, 1)

		const started = cpuMs()

		expect(movedShapes(saved, now)).toHaveLength(19_999)
		expect(movedShapes(saved, local)).toEqual([])
		expect(movedShapes(saved, [20_000, ...saved.slice(0, -1)])).toEqual([20_000])
		expect(cpuMs() - started).toBeLessThan(budget(500))
	})
})
