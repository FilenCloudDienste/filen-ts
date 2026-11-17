import { afterEach, describe, expect, it, vi } from "vitest"
import { workerJob, WorkerJobTimeoutError } from "@/features/preview/lib/workerJob"
import { WorkerGoneError } from "@/lib/workers/ownedWorker.logic"
import type { IdleResource } from "@/lib/idleResource"

// A job past its budget ends the shared worker and fails; a job the same worker was running is tried once more on a
// fresh one, so a single slow file holds nothing else back.

interface FakeWorker {
	readonly id: number
	ended: boolean
	readonly gone: Promise<never>
	readonly end: () => void
}

function fakePool(): IdleResource<FakeWorker> & { created: () => number } {
	let current: FakeWorker | null = null
	let created = 0

	const make = (): FakeWorker => {
		const { promise, reject } = Promise.withResolvers<never>()

		promise.catch(() => undefined)

		const worker: FakeWorker = {
			id: ++created,
			ended: false,
			gone: promise,
			end: () => {
				worker.ended = true
				reject(new WorkerGoneError("fake", "terminated"))
			}
		}

		return worker
	}

	return {
		created: () => created,
		use: run => {
			current ??= make()

			const worker = current

			return Promise.race([run(worker), worker.gone])
		},
		disposeIfIdle: () => undefined,
		invalidate: worker => {
			if (current === worker) current = null

			worker.end()
		}
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("workerJob", () => {
	it("ends a job past its budget, and runs a job that shared its worker again on a fresh one", async () => {
		vi.useFakeTimers()

		const pool = fakePool()
		const slow = workerJob(pool, "test", 1000, () => new Promise<string>(() => undefined))
		let attempts = 0
		const other = workerJob(pool, "test", 5000, worker => {
			attempts++

			return worker.id === 1 ? new Promise<string>(() => undefined) : Promise.resolve(`done on ${String(worker.id)}`)
		})

		const slowResult = slow.catch((e: unknown) => e)

		await vi.advanceTimersByTimeAsync(1000)

		expect(await slowResult).toBeInstanceOf(WorkerJobTimeoutError)
		expect(await other).toBe("done on 2")
		expect(attempts).toBe(2)
		expect(pool.created()).toBe(2)
	})

	it("passes a job's own failure through, and gives up after one retry", async () => {
		const pool = fakePool()

		await expect(workerJob(pool, "test", 1000, () => Promise.reject(new Error("bad file")))).rejects.toThrow("bad file")
		await expect(workerJob(pool, "test", 1000, () => Promise.reject(new WorkerGoneError("test", "terminated")))).rejects.toBeInstanceOf(
			WorkerGoneError
		)
	})
})
