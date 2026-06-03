import { describe, it, expect } from "vitest"
import { ClearBarrier } from "@/lib/clearBarrier"

function deferred<T = void>(): {
	promise: Promise<T>
	resolve: (value: T) => void
} {
	let resolve!: (value: T) => void

	const promise = new Promise<T>(r => {
		resolve = r
	})

	return {
		promise,
		resolve
	}
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}

describe("ClearBarrier", () => {
	it("allows multiple concurrent enter/leave pairs", async () => {
		const barrier = new ClearBarrier()

		await barrier.enter()
		await barrier.enter()
		await barrier.enter()

		barrier.leave()
		barrier.leave()
		barrier.leave()
	})

	it("runExclusive resolves immediately when no enters are in flight", async () => {
		const barrier = new ClearBarrier()

		let ran = false

		await barrier.runExclusive(() => {
			ran = true
		})

		expect(ran).toBe(true)
	})

	it("runExclusive waits for in-flight enters to drain", async () => {
		const barrier = new ClearBarrier()

		await barrier.enter()

		let exclusiveRan = false

		const exclusivePromise = barrier.runExclusive(() => {
			exclusiveRan = true
		})

		await flushMicrotasks()

		expect(exclusiveRan).toBe(false)

		barrier.leave()

		await exclusivePromise

		expect(exclusiveRan).toBe(true)
	})

	it("blocks new enters while runExclusive is active", async () => {
		const barrier = new ClearBarrier()
		const release = deferred()

		const exclusivePromise = barrier.runExclusive(() => release.promise)

		let entered = false

		const enterPromise = barrier.enter().then(() => {
			entered = true
		})

		await flushMicrotasks()

		expect(entered).toBe(false)

		release.resolve()

		await exclusivePromise
		await enterPromise

		expect(entered).toBe(true)

		barrier.leave()
	})

	it("all enters queued during a runExclusive resume after the exclusive completes and inflight returns to 0", async () => {
		const barrier = new ClearBarrier()
		const release = deferred()

		const exclusivePromise = barrier.runExclusive(() => release.promise)

		let entered1 = false
		let entered2 = false
		let entered3 = false

		const enter1 = barrier.enter().then(() => {
			entered1 = true
		})

		const enter2 = barrier.enter().then(() => {
			entered2 = true
		})

		const enter3 = barrier.enter().then(() => {
			entered3 = true
		})

		await flushMicrotasks()

		expect(entered1).toBe(false)
		expect(entered2).toBe(false)
		expect(entered3).toBe(false)

		release.resolve()

		await exclusivePromise
		await Promise.all([enter1, enter2, enter3])

		expect(entered1).toBe(true)
		expect(entered2).toBe(true)
		expect(entered3).toBe(true)

		// All three entered — inflight is 3. Drain all of them and verify
		// a subsequent runExclusive can proceed immediately (inflight back to 0).
		barrier.leave()
		barrier.leave()
		barrier.leave()

		let postDrainRan = false

		await barrier.runExclusive(() => {
			postDrainRan = true
		})

		expect(postDrainRan).toBe(true)
	})

	it("queues multiple runExclusive callers in order", async () => {
		const barrier = new ClearBarrier()
		const order: number[] = []
		const releases = [deferred(), deferred()]

		const exclusiveA = barrier.runExclusive(async () => {
			order.push(1)

			await releases[0]!.promise

			order.push(2)
		})

		const exclusiveB = barrier.runExclusive(async () => {
			order.push(3)

			await releases[1]!.promise

			order.push(4)
		})

		await flushMicrotasks()

		expect(order).toEqual([1])

		releases[0]!.resolve()

		await exclusiveA
		await flushMicrotasks()

		expect(order).toEqual([1, 2, 3])

		releases[1]!.resolve()

		await exclusiveB

		expect(order).toEqual([1, 2, 3, 4])
	})

	it("supports a long-running enter that overlaps a runExclusive request", async () => {
		const barrier = new ClearBarrier()

		await barrier.enter()

		const exclusiveRan = deferred()

		const exclusivePromise = barrier.runExclusive(async () => {
			exclusiveRan.resolve()
		})

		// Simulate the long-running enter finishing after a macrotask.
		const longEnterLeave = new Promise<void>(resolve => {
			setTimeout(() => {
				barrier.leave()
				resolve()
			}, 0)
		})

		await longEnterLeave
		await exclusivePromise

		// exclusiveRan.promise must have resolved — exclusive body ran after leave().
		await expect(exclusiveRan.promise).resolves.toBeUndefined()
	})

	it("leave is a no-op when no enter has happened", () => {
		const barrier = new ClearBarrier()

		expect(() => barrier.leave()).not.toThrow()
	})

	it("leave called multiple times beyond enter count is always a no-op", () => {
		const barrier = new ClearBarrier()

		// Call leave many times with inflight === 0 — must never throw.
		for (let i = 0; i < 5; i++) {
			expect(() => barrier.leave()).not.toThrow()
		}
	})

	it("leave called once too many after a legitimate enter/leave pair is a no-op", async () => {
		const barrier = new ClearBarrier()

		await barrier.enter()
		barrier.leave() // legitimate

		// Now inflight is 0 — extra leave must be silent.
		expect(() => barrier.leave()).not.toThrow()

		// Subsequent runExclusive must still work.
		let ran = false

		await barrier.runExclusive(() => {
			ran = true
		})

		expect(ran).toBe(true)
	})

	it("runExclusive surfaces a synchronous return value", async () => {
		const barrier = new ClearBarrier()

		await expect(barrier.runExclusive(() => 42)).resolves.toBe(42)
	})

	it("runExclusive surfaces an async (Promise<T>) return value", async () => {
		const barrier = new ClearBarrier()

		const result = await barrier.runExclusive(async () => {
			await Promise.resolve()
			return "async-result"
		})

		expect(result).toBe("async-result")
	})

	it("runExclusive surfaces a synchronous throw", async () => {
		const barrier = new ClearBarrier()

		await expect(
			barrier.runExclusive(() => {
				throw new Error("boom")
			})
		).rejects.toThrow("boom")
	})

	it("runExclusive surfaces an async rejection", async () => {
		const barrier = new ClearBarrier()

		await expect(
			barrier.runExclusive(async () => {
				await Promise.resolve()
				throw new Error("async-boom")
			})
		).rejects.toThrow("async-boom")
	})

	it("releases the exclusive lock even when the inner function throws", async () => {
		const barrier = new ClearBarrier()

		await expect(
			barrier.runExclusive(() => {
				throw new Error("boom")
			})
		).rejects.toThrow("boom")

		let ran = false

		await barrier.runExclusive(() => {
			ran = true
		})

		expect(ran).toBe(true)
	})

	it("enter() re-entrant after completed exclusive creates a fresh drained promise", async () => {
		const barrier = new ClearBarrier()

		// First exclusive cycle.
		await barrier.enter()
		barrier.leave()

		let firstExclusiveRan = false

		await barrier.runExclusive(() => {
			firstExclusiveRan = true
		})

		expect(firstExclusiveRan).toBe(true)

		// Now do a second enter → runExclusive cycle to verify the drained promise
		// was properly reset and the second exclusive waits for the new enter.
		await barrier.enter()

		let secondExclusiveRan = false

		const secondExclusive = barrier.runExclusive(() => {
			secondExclusiveRan = true
		})

		await flushMicrotasks()

		// Second exclusive should be blocked while inflight > 0.
		expect(secondExclusiveRan).toBe(false)

		barrier.leave()

		await secondExclusive

		expect(secondExclusiveRan).toBe(true)
	})

	it("queued exclusives plus queued readers: each exclusive drains before its body runs", async () => {
		const barrier = new ClearBarrier()
		const releaseA = deferred()
		const releaseB = deferred()
		const order: string[] = []

		// One reader in flight.
		await barrier.enter()
		order.push("reader-entered")

		// Queue two exclusives behind the reader.
		const exclusiveA = barrier.runExclusive(async () => {
			order.push("exclusive-A-start")
			await releaseA.promise
			order.push("exclusive-A-end")
		})

		const exclusiveB = barrier.runExclusive(async () => {
			order.push("exclusive-B-start")
			await releaseB.promise
			order.push("exclusive-B-end")
		})

		// Queue a reader that will be admitted after exclusiveA finishes.
		let readerAfterA = false
		const enterAfterA = barrier.enter().then(() => {
			readerAfterA = true
			order.push("reader-after-A-entered")
		})

		await flushMicrotasks()

		// Neither exclusive has started yet — drain hasn't happened.
		expect(order).toEqual(["reader-entered"])

		// Drain the first reader — exclusiveA can now start.
		barrier.leave()
		order.push("reader-left")

		await flushMicrotasks()

		// exclusiveA's body must have started.
		expect(order).toContain("exclusive-A-start")
		expect(order).not.toContain("exclusive-B-start")
		// The queued reader must still be blocked.
		expect(readerAfterA).toBe(false)

		releaseA.resolve()
		await exclusiveA
		await flushMicrotasks()

		// exclusiveA done → enterAfterA is still blocked by exclusiveB.
		// exclusiveB has started.
		expect(order).toContain("exclusive-A-end")
		expect(order).toContain("exclusive-B-start")

		releaseB.resolve()
		await exclusiveB

		// After exclusiveB finishes, the queued reader is unblocked.
		await enterAfterA

		expect(readerAfterA).toBe(true)
		expect(order).toContain("exclusive-B-end")
		expect(order).toContain("reader-after-A-entered")

		// Clean up.
		barrier.leave()
	})
})
