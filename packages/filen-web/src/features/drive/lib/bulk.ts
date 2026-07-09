// Generic partial-success runner. Deliberately departs from filen-mobile's bulkOps.ts, which is
// fail-fast (Promise.all, returns a boolean, first rejection aborts the batch): a bulk drive action
// runs every item independently, in parallel, with a per-item catch — one failure must not strand
// the rest (nor lose which items succeeded). Domain-agnostic: `error` is whatever `perItem` threw,
// unnormalized — the caller decides how to turn it into a message.
export interface BulkFailure<T> {
	item: T
	error: unknown
}

export interface BulkOutcome<T> {
	succeeded: T[]
	failed: BulkFailure<T>[]
}

export async function runBulk<T>(items: T[], perItem: (item: T) => Promise<void>): Promise<BulkOutcome<T>> {
	const settled = await Promise.all(
		items.map(async item => {
			try {
				await perItem(item)
				return { ok: true as const, item }
			} catch (error) {
				return { ok: false as const, item, error }
			}
		})
	)

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
