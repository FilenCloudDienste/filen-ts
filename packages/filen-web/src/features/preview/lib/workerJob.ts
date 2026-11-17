import { WorkerGoneError } from "@/lib/workers/ownedWorker.logic"
import type { IdleResource } from "@/lib/idleResource"

// A job on a shared stateless worker, held to a time budget of its own work: past it the worker is ended (the only way
// to stop a parse that is running), so no one file holds every other reading back. Time the job spends waiting on the
// page (a range it asked the page to download) is not counted: `clock.pause()` / `clock.resume()` around such a wait. The job past its budget fails with
// WorkerJobTimeoutError; another job the same worker was running at the time is tried once more on a fresh worker.

export class WorkerJobTimeoutError extends Error {
	public constructor(label: string, budgetMs: number) {
		super(`${label} job ran past its ${String(budgetMs)} ms budget`)
		this.name = "WorkerJobTimeoutError"
	}
}

export interface JobClock {
	pause(): void
	resume(): void
}

export async function workerJob<H, R>(
	pool: IdleResource<H>,
	label: string,
	budgetMs: number,
	run: (handle: H, clock: JobClock) => Promise<R>
): Promise<R> {
	for (let attempt = 0; ; attempt++) {
		const budget = { spent: false }

		try {
			return await pool.use(handle => {
				let remaining = budgetMs
				let started = 0
				let paused = 0
				let timer: ReturnType<typeof setTimeout> | null = null

				const start = (): void => {
					started = performance.now()
					timer = setTimeout(() => {
						budget.spent = true
						pool.invalidate(handle)
					}, remaining)
				}

				const stop = (): void => {
					if (timer !== null) {
						clearTimeout(timer)
						timer = null
						remaining -= performance.now() - started
					}
				}

				const clock: JobClock = {
					pause: () => {
						if (paused++ === 0) stop()
					},
					resume: () => {
						if (paused > 0 && --paused === 0 && !budget.spent) start()
					}
				}

				start()

				return run(handle, clock).finally(stop)
			})
		} catch (e) {
			if (budget.spent) {
				throw new WorkerJobTimeoutError(label, budgetMs)
			}

			if (e instanceof WorkerGoneError && attempt === 0) {
				continue
			}

			throw e
		}
	}
}
