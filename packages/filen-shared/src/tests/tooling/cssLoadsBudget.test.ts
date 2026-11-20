import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { keptCss } from "@filen/shared/dom/cssLoads"

setFlagsFromString("--expose-gc")

const collect: unknown = runInNewContext("gc")

if (typeof collect !== "function") {
	throw new Error("no gc: the heap bounds cannot be measured")
}

const gc = collect as () => void

const MIB = 1024 * 1024

// Heap growth over one judgement, from a collected heap: as the call returns (what it allocated and the collector
// has not reached, which depends on when it ran) and after a collection (what is still held, the result included).
function judged(css: string): { dropped: number; grown: number; held: number } {
	gc()
	gc()

	const before = process.memoryUsage().heapUsed
	const result = keptCss(css, "sheet", () => null)
	const grown = process.memoryUsage().heapUsed - before

	gc()
	gc()

	return { dropped: result.dropped, grown, held: process.memoryUsage().heapUsed - before }
}

// Beside the tooling tests because it needs Node (a forced collection), which the other tests may not import.
// The CSS judge streams: no token is kept past its chunk, and no value is built a character at a time.
describe("keptCss budget", () => {
	it("judges 8 MiB of rules, and one 8 MiB token, in bounded time and heap", () => {
		const started = Date.now()
		// 1.4 million small rules allocate far more than they keep, and how much of that is still uncollected at the
		// return is the collector's timing, so the rules are bounded by what stays held.
		const rules = judged("a{b:c}".repeat(1_398_101))
		// One token of 8 MiB is one allocation of its size: built a character at a time it would grow the heap by a
		// multiple of that before the call returns.
		const token = judged(`a{b:${"x".repeat(8 * MIB)}}`)
		const string = judged(`a{b:"${"x".repeat(8 * MIB)}"}`)

		expect(rules.dropped + token.dropped + string.dropped).toBe(0)
		expect(Date.now() - started).toBeLessThan(5000)
		expect(rules.held).toBeLessThan(48 * MIB)
		expect(token.grown).toBeLessThan(32 * MIB)
		expect(string.grown).toBeLessThan(32 * MIB)
	})
})
