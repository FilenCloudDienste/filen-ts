import { describe, expect, it, vi } from "vitest"
import { createShareProgress } from "@/features/drive/lib/share/progress.logic"

const fraction = (value: number) => [{ kind: "fraction", value }]

describe("createShareProgress", () => {
	it("counts a settled pair as whole and a directory pair by its items shared, over every pair", () => {
		const report = vi.fn()
		const nextPair = createShareProgress(4, report)
		const file = nextPair(false)
		const dir = nextPair(true)

		file.settle()
		// The listing moves nothing; only items do.
		dir.bytes(50, 100)
		dir.items(5, 10)

		expect(report.mock.calls).toEqual([fraction(0.25), fraction(0.375)])
	})

	it("reports only when the whole percent changes", () => {
		const report = vi.fn()
		const nextPair = createShareProgress(2, report)
		const pair = nextPair(true)

		nextPair(false)
		pair.items(1, 1000)
		pair.items(5, 1000)
		pair.items(19, 1000)
		pair.items(20, 1000)

		expect(report.mock.calls).toEqual([fraction(0.01)])
	})

	it("ignores an empty total, a step backwards and anything after the pair settled", () => {
		const report = vi.fn()
		const nextPair = createShareProgress(2, report)
		const pair = nextPair(true)

		pair.items(0, 0)
		pair.items(60, 100)
		pair.items(40, 100)
		pair.settle()
		// Its last tick, crossing on its own port after the result.
		pair.items(90, 100)

		expect(report.mock.calls).toEqual([fraction(0.3), fraction(0.5)])
	})

	it("never counts a pair past whole", () => {
		const report = vi.fn()
		const nextPair = createShareProgress(2, report)
		const pair = nextPair(true)

		pair.items(150, 100)
		pair.settle()

		expect(report.mock.calls).toEqual([fraction(0.5)])
	})

	it("reports a lone file pair as whole once it settles", () => {
		const report = vi.fn()

		createShareProgress(1, report)(false).settle()

		expect(report.mock.calls).toEqual([fraction(1)])
	})

	it("shows a lone directory pair's own phases from the start: reading its tree, then its items shared", () => {
		const report = vi.fn()
		const pair = createShareProgress(1, report)(true)

		pair.bytes(50, 100)
		pair.items(0, 3)
		// A listing tick crossing after the first items report never takes the phase back.
		pair.bytes(100, 100)
		pair.items(3, 3)
		pair.settle()
		pair.items(3, 3)

		expect(report.mock.calls).toEqual([
			[{ kind: "directory", progress: { phase: "reading", fraction: undefined } }],
			[{ kind: "directory", progress: { phase: "reading", fraction: 0.5 } }],
			[{ kind: "directory", progress: { phase: "items", done: 0, total: 3 } }],
			[{ kind: "directory", progress: { phase: "items", done: 3, total: 3 } }]
		])
	})
})
