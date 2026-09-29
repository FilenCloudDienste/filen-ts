import { type VoidActionOutcome } from "@/lib/actions/outcome"

// Generic partial-success runner. Deliberately departs from filen-mobile's bulkOps.ts, which is
// fail-fast (Promise.all, returns a boolean, first rejection aborts the batch): a bulk action runs
// every item independently, in parallel, with a per-item catch — one failure must not strand the
// rest (nor lose which items succeeded). `error` is whatever `perItem` threw (or the outcome's dto),
// unnormalized — the caller decides how to turn it into a message.
export interface BulkFailure<T> {
	item: T
	error: unknown
}

export interface BulkOutcome<T> {
	succeeded: T[]
	failed: BulkFailure<T>[]
}

type Settled<T> = { ok: true; item: T } | { ok: false; item: T; error: unknown }

function split<T>(settled: Settled<T>[]): BulkOutcome<T> {
	const succeeded: T[] = []
	const failed: BulkFailure<T>[] = []

	for (const result of settled) {
		if (result.ok) {
			succeeded.push(result.item)
		} else {
			failed.push({ item: result.item, error: result.error })
		}
	}

	return { succeeded, failed }
}

export async function runBulk<T>(items: readonly T[], perItem: (item: T) => Promise<void>): Promise<BulkOutcome<T>> {
	return split(
		await Promise.all(
			items.map(async (item): Promise<Settled<T>> => {
				try {
					await perItem(item)

					return { ok: true, item }
				} catch (error) {
					return { ok: false, item, error }
				}
			})
		)
	)
}

// runBulk over the never-throwing outcome-returning action helpers: an error outcome fails its item
// with the outcome's ErrorDTO, exactly as if perItem had thrown it.
export async function runBulkOutcomes<T>(items: readonly T[], perItem: (item: T) => Promise<VoidActionOutcome>): Promise<BulkOutcome<T>> {
	return split(
		await Promise.all(
			items.map(async (item): Promise<Settled<T>> => {
				try {
					const outcome = await perItem(item)

					return outcome.status === "success" ? { ok: true, item } : { ok: false, item, error: outcome.dto }
				} catch (error) {
					return { ok: false, item, error }
				}
			})
		)
	)
}
