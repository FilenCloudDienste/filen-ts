import { afterEach, describe, expect, it, vi } from "vitest"
import { NestedWorker, type NestedResponse } from "@/workers/nestedWorker"

class FakeWorker {
	public terminated = false
	public readonly posted: { id: number; type: string }[] = []
	private readonly listeners = new Map<string, ((event: unknown) => void)[]>()

	public addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
	}

	public postMessage(message: { id: number; type: string }): void {
		this.posted.push(message)
	}

	public terminate(): void {
		this.terminated = true
	}

	public answer(response: NestedResponse & Record<string, unknown>): void {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: response })
		}
	}

	public unreadable(): void {
		for (const listener of this.listeners.get("messageerror") ?? []) {
			listener({ data: null })
		}
	}
}

function nested(idleMs = 0, toError?: (message: string) => Error, toLostError?: (message: string) => Error) {
	const spawned: FakeWorker[] = []
	const helper = new NestedWorker<{ type: string }, NestedResponse>(
		() => {
			const worker = new FakeWorker()

			spawned.push(worker)

			return worker as unknown as Worker
		},
		{ name: "test", idleMs, ...(toError === undefined ? {} : { toError }), ...(toLostError === undefined ? {} : { toLostError }) }
	)

	return { helper, spawned }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("NestedWorker", () => {
	it("shares one worker between users and stops it with the last", () => {
		const { helper, spawned } = nested()
		const first = helper.acquire()
		const second = helper.acquire()

		expect(first).toBe(second)
		helper.release()
		expect(spawned[0]?.terminated).toBe(false)
		helper.release()
		expect(spawned[0]?.terminated).toBe(true)
		expect(helper.acquire()).not.toBe(first)
		expect(spawned).toHaveLength(2)
	})

	it("keeps the worker for its idle grace, for a user that comes back within it", () => {
		vi.useFakeTimers()

		const { helper, spawned } = nested(30_000)
		const worker = helper.acquire()

		helper.release()
		vi.advanceTimersByTime(29_000)
		expect(helper.acquire()).toBe(worker)
		helper.release()
		vi.advanceTimersByTime(30_000)
		expect(spawned[0]?.terminated).toBe(true)
	})

	it("answers by id, rejects an error answer with the error it names, and drops the worker on a fatal one", async () => {
		const { helper, spawned } = nested(
			0,
			message => new TypeError(message),
			message => new RangeError(message)
		)
		const worker = helper.acquire()
		const fake = spawned[0]
		const ok = helper.request(worker, { type: "a" })
		const failed = helper.request(worker, { type: "b" })
		const waiting = helper.request(worker, { type: "c" })

		fake?.answer({ id: 1, error: "source" })
		fake?.answer({ id: 0, value: 1 })
		await expect(ok).resolves.toMatchObject({ id: 0, value: 1 })
		await expect(failed).rejects.toBeInstanceOf(TypeError)

		fake?.answer({ id: 99, fatal: "trapped" })
		await expect(waiting).rejects.toThrow(RangeError)
		expect(fake?.terminated).toBe(true)
		await expect(helper.request(worker, { type: "d" })).rejects.toThrow("lost")
	})

	it("drops a worker that does not answer within a request's deadline, failing only what waits on it", async () => {
		vi.useFakeTimers()

		const { helper, spawned } = nested(0, undefined, message => new RangeError(message))
		const worker = helper.acquire()
		const quick = helper.request(worker, { type: "render" }, [], 2_000)
		const other = helper.request(worker, { type: "other" })

		vi.advanceTimersByTime(1_999)
		expect(spawned[0]?.terminated).toBe(false)
		vi.advanceTimersByTime(1)
		await expect(quick).rejects.toThrow(RangeError)
		await expect(other).rejects.toThrow("did not answer")
		expect(spawned[0]?.terminated).toBe(true)

		// Its user releases as before, and the next one starts a fresh worker.
		helper.release(worker)
		expect(helper.acquire()).not.toBe(worker)
	})

	it("clears a deadline once its answer came", async () => {
		vi.useFakeTimers()

		const { helper, spawned } = nested()
		const worker = helper.acquire()
		const answered = helper.request(worker, { type: "render" }, [], 2_000)

		spawned[0]?.answer({ id: 0 })
		await expect(answered).resolves.toMatchObject({ id: 0 })
		vi.advanceTimersByTime(10_000)
		expect(spawned[0]?.terminated).toBe(false)
	})

	it("drops a worker whose answer could not be read", async () => {
		const { helper, spawned } = nested()
		const worker = helper.acquire()
		const waiting = helper.request(worker, { type: "a" })

		spawned[0]?.unreadable()
		await expect(waiting).rejects.toThrow("could not be read")
		expect(spawned[0]?.terminated).toBe(true)
	})

	it("arms one idle timer however often the last user releases", () => {
		vi.useFakeTimers()

		const { helper, spawned } = nested(30_000)
		const worker = helper.acquire()

		helper.release(worker)
		vi.advanceTimersByTime(20_000)
		helper.release(worker)
		vi.advanceTimersByTime(20_000)
		expect(spawned[0]?.terminated).toBe(false)
		vi.advanceTimersByTime(10_000)
		expect(spawned[0]?.terminated).toBe(true)
	})

	it("sends no new user to a retired worker, and ends it with the last user it had", async () => {
		const { helper, spawned } = nested(30_000)
		const old = helper.acquire()

		helper.acquire()
		helper.retire(old)

		const fresh = helper.acquire()

		expect(fresh).not.toBe(old)
		expect(helper.current(old)).toBe(true)

		const answer = helper.request(old, { type: "render" })

		spawned[0]?.answer({ id: 0 })
		await expect(answer).resolves.toMatchObject({ id: 0 })
		helper.release(old)
		expect(spawned[0]?.terminated).toBe(false)
		helper.release(old)
		expect(spawned[0]?.terminated).toBe(true)
		expect(helper.current(old)).toBe(false)
		// The fresh worker's user is untouched by the old one's releases.
		expect(spawned[1]?.terminated).toBe(false)
		helper.release(fresh)
		expect(spawned[1]?.terminated).toBe(false)
	})

	it("ends a retired worker at once when no one uses it", () => {
		const { helper, spawned } = nested(30_000)
		const worker = helper.acquire()

		helper.release(worker)
		helper.retire(worker)
		expect(spawned[0]?.terminated).toBe(true)
		expect(helper.acquire()).not.toBe(worker)
	})
})
