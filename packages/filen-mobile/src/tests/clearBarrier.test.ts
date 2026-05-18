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

		const longEnterLeave = deferred()

		const exclusiveRan = deferred()

		const exclusivePromise = barrier.runExclusive(async () => {
			exclusiveRan.resolve()
		})

		// Simulate the long-running enter finishing later.
		setTimeout(() => {
			barrier.leave()
			longEnterLeave.resolve()
		}, 0)

		await longEnterLeave.promise
		await exclusivePromise
		await exclusiveRan.promise
	})

	it("leave is a no-op when no enter has happened", () => {
		const barrier = new ClearBarrier()

		expect(() => barrier.leave()).not.toThrow()
	})

	it("runExclusive surfaces the function's return value and rejections", async () => {
		const barrier = new ClearBarrier()

		await expect(barrier.runExclusive(() => 42)).resolves.toBe(42)

		await expect(
			barrier.runExclusive(() => {
				throw new Error("boom")
			})
		).rejects.toThrow("boom")
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
})
