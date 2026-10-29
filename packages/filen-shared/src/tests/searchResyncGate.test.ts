import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SearchResyncGate } from "@filen/shared"

// The SDK's window re-reads after its own debounce, so the post-Finished snapshot lands late (276ms
// measured on a ~4,400-item account; more on a big one). Modelled with fake timers.
function reread(total: bigint, afterMs = 0): () => Promise<bigint> {
	return () =>
		new Promise<bigint>(resolve => {
			setTimeout(() => {
				resolve(total)
			}, afterMs)
		})
}

describe("SearchResyncGate", () => {
	let changes: boolean[]
	let gate: SearchResyncGate

	beforeEach(() => {
		vi.useFakeTimers()
		changes = []
		gate = new SearchResyncGate(converging => {
			changes.push(converging)
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("never converges on a warm cache (no resync covering the root)", async () => {
		gate.snapshot(3n)
		gate.finished(reread(3n))
		await vi.runAllTimersAsync()

		expect(gate.converging).toBe(false)
		expect(changes).toEqual([])
	})

	it("converges from Started until settled", () => {
		gate.snapshot(0n)
		gate.started()

		expect(gate.converging).toBe(true)
		expect(changes).toEqual([true])
	})

	it.each([300, 900])("stays converging after Finished until the snapshot that lands %ims later", async delay => {
		gate.snapshot(0n)
		gate.started()
		// The engine already holds 5 matches; the delivered window still says 0.
		gate.finished(reread(5n))

		await vi.advanceTimersByTimeAsync(delay - 1)

		expect(gate.converging).toBe(true)

		await vi.advanceTimersByTimeAsync(1)
		gate.snapshot(5n)

		expect(gate.converging).toBe(false)
		expect(changes).toEqual([true, false])
	})

	it("settles a genuine empty result as soon as the re-read agrees", async () => {
		gate.snapshot(0n)
		gate.started()
		gate.finished(reread(0n, 5))

		expect(gate.converging).toBe(true)

		await vi.advanceTimersByTimeAsync(5)

		expect(gate.converging).toBe(false)
	})

	it("settles on the first snapshot after Finished even before the re-read answers", async () => {
		gate.snapshot(0n)
		gate.started()
		gate.finished(reread(2n, 1_000))
		gate.snapshot(2n)

		expect(gate.converging).toBe(false)

		await vi.runAllTimersAsync()

		expect(changes).toEqual([true, false])
	})

	it("waits for the first snapshot when Finished arrives before the window exists", () => {
		gate.started()
		gate.finished(null)

		expect(gate.converging).toBe(true)

		gate.snapshot(0n)

		expect(gate.converging).toBe(false)
	})

	it("settles when the re-read fails (search gone), leaving nothing stuck", async () => {
		gate.snapshot(0n)
		gate.started()
		gate.finished(() => Promise.reject(new Error("closed")))
		await vi.runAllTimersAsync()

		expect(gate.converging).toBe(false)
	})

	it("ignores a stale re-read once a newer resync started", async () => {
		gate.snapshot(0n)
		gate.started()
		gate.finished(reread(0n, 10))
		gate.started()
		await vi.advanceTimersByTimeAsync(10)

		expect(gate.converging).toBe(true)
	})

	it("reset forgets an in-flight finalize without notifying", async () => {
		gate.snapshot(0n)
		gate.started()
		gate.finished(reread(0n, 10))
		gate.reset()
		await vi.advanceTimersByTimeAsync(10)

		expect(gate.converging).toBe(false)
		expect(changes).toEqual([true])
	})
})
