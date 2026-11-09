import { describe, expect, it } from "vitest"
import { transferables } from "../dom/sheet/messages"
import { budget, cpuMs } from "./timing"

describe("sheet transferables", () => {
	it("collects each whole-buffer typed array once, at any depth up to the limit", () => {
		const a = new Float64Array(4)
		const b = new Uint32Array(2)
		const view = new Uint8Array(new ArrayBuffer(16), 4, 4)
		const shared = new Uint8Array(8)
		const deep = new Uint8Array(1)
		let nested: unknown = { deep }

		for (let i = 0; i < 9; i++) nested = { next: nested }

		const found = transferables({
			tiles: [{ values: a, strings: ["x", "y"] }, { values: b }, { values: shared }, { values: shared }],
			view,
			set: new Set([new Uint8Array(1)]),
			map: new Map([["k", new Uint8Array(1)]]),
			nested
		})

		expect(found).toEqual([a.buffer, b.buffer, shared.buffer])
		expect(transferables(a)).toEqual([a.buffer])
		expect(transferables(null)).toEqual([])
		expect(transferables("text")).toEqual([])
	})

	it("stays linear in the number of buffers", () => {
		const tiles = Array.from({ length: 20_000 }, () => ({
			values: new Float64Array(1),
			flags: new Uint8Array(1),
			strings: [] as string[]
		}))
		const message = { tiles }
		let best = Infinity
		let found: ArrayBuffer[] = []

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()

			found = transferables(message)
			best = Math.min(best, cpuMs() - start)
		}

		expect(found.length).toBe(40_000)
		expect(best).toBeLessThan(budget(60))
	})
})
