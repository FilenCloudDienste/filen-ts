import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closeWithin } from "../native/shutdown.ts"

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

const log = { warn: vi.fn(), describe: String }

function engine() {
	const close = Promise.withResolvers<undefined>()

	return { close: vi.fn(() => close.promise), closed: close }
}

describe("closeWithin", () => {
	it("returns only once the engine and rclone closed", async () => {
		const open = engine()
		const stop = Promise.withResolvers<undefined>()
		let done = false

		void closeWithin({ opening: () => null, engine: () => open, mounts: () => ({ shutdown: () => stop.promise }) }, 20_000, log).then(
			closed => {
				done = closed
			}
		)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(open.close).toHaveBeenCalledOnce()
		expect(done).toBe(false)

		open.closed.resolve(undefined)
		await vi.advanceTimersByTimeAsync(0)
		expect(done).toBe(false)

		stop.resolve(undefined)
		await vi.advanceTimersByTimeAsync(0)
		expect(done).toBe(true)
	})

	it("closes an engine that opens during the shutdown", async () => {
		const late = engine()
		const opening = Promise.withResolvers<typeof late>()
		const closing = closeWithin({ opening: () => opening.promise, engine: () => null, mounts: () => null }, 20_000, log)

		await vi.advanceTimersByTimeAsync(1_000)
		expect(late.close).not.toHaveBeenCalled()

		opening.resolve(late)
		await vi.advanceTimersByTimeAsync(0)
		expect(late.close).toHaveBeenCalledOnce()

		late.closed.resolve(undefined)
		await expect(closing).resolves.toBe(true)
	})

	it("gives up on a close that hangs, and on one that fails", async () => {
		const hung = engine()
		const closing = closeWithin({ opening: () => null, engine: () => hung, mounts: () => null }, 20_000, log)

		await vi.advanceTimersByTimeAsync(19_999)
		await vi.advanceTimersByTimeAsync(1)
		await expect(closing).resolves.toBe(false)
		expect(log.warn).toHaveBeenCalledWith("engine close or rclone stop timed out")

		const failing = { close: () => Promise.reject(new Error("boom")) }

		await expect(
			closeWithin(
				{
					opening: () => Promise.resolve(null),
					engine: () => failing,
					mounts: () => ({ shutdown: () => Promise.reject(new Error("rc")) })
				},
				20_000,
				log
			)
		).resolves.toBe(true)
		expect(log.warn).toHaveBeenCalledWith("engine close failed: Error: boom")
		expect(log.warn).toHaveBeenCalledWith("rclone stop failed: Error: rc")
	})
})
