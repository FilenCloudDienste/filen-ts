import { WorkerGoneError } from "@/lib/workers/ownedWorker.logic"
import type { IdleResource } from "@/lib/idleResource"

// A job on a shared stateless worker, held to a time budget: past it the worker is ended (the only way to stop a
// parse that is running), so no one file holds every other reading back. The job past its budget fails with
// WorkerJobTimeoutError; another job the same worker was running at the time is tried once more on a fresh worker.

export class WorkerJobTimeoutError extends Error {
	public constructor(label: string, budgetMs: number) {
		super(`${label} job ran past its ${String(budgetMs)} ms budget`)
		this.name = "WorkerJobTimeoutError"
	}
}

export async function workerJob<H, R>(pool: IdleResource<H>, label: string, budgetMs: number, run: (handle: H) => Promise<R>): Promise<R> {
	for (let attempt = 0; ; attempt++) {
		const budget = { spent: false }

		try {
			return await pool.use(handle => {
				const timer = setTimeout(() => {
					budget.spent = true
					pool.invalidate(handle)
				}, budgetMs)

				return run(handle).finally(() => {
					clearTimeout(timer)
				})
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
