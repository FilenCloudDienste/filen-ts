import { describe, expect, it, vi } from "vitest"
import { createShareProgress } from "@/features/drive/lib/share/progress.logic"

describe("createShareProgress", () => {
	it("counts a settled pair as whole and a directory pair by its bytes, over every pair", () => {
		const report = vi.fn()
		const nextPair = createShareProgress(4, report)
		const file = nextPair()
		const dir = nextPair()

		file.settle()
		dir.progress(50, 100)

		expect(report.mock.calls).toEqual([[0.25], [0.375]])
	})

	it("reports only when the whole percent changes", () => {
		const report = vi.fn()
		const pair = createShareProgress(1, report)()

		pair.progress(1, 1000)
		pair.progress(5, 1000)
		pair.progress(9, 1000)
		pair.progress(10, 1000)

		expect(report.mock.calls).toEqual([[0.01]])
	})

	it("ignores a tick without a total, a step backwards and anything after the pair settled", () => {
		const report = vi.fn()
		const nextPair = createShareProgress(2, report)
		const pair = nextPair()

		pair.progress(10, undefined)
		pair.progress(60, 100)
		pair.progress(40, 100)
		pair.settle()
		// Its last tick, crossing on its own port after the result.
		pair.progress(90, 100)

		expect(report.mock.calls).toEqual([[0.3], [0.5]])
	})

	it("never counts a pair past whole", () => {
		const report = vi.fn()
		const pair = createShareProgress(1, report)()

		pair.progress(150, 100)
		pair.settle()

		expect(report.mock.calls).toEqual([[1]])
	})
})
