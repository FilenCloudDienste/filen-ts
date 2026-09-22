// The notes-list date/status partition, shared by mobile's notesSorter.group and web's
// groupNotesForView. Classification core only: first-match-wins into pinned → favorited →
// today → previous 7 days → previous 30 days → previous month → year(s) desc → archived →
// trashed, empty buckets omitted. No labels, no icons, no row model — each app resolves its
// own header text/icon from the returned bucket id and keeps its own presentation row shape.

export type NoteBucketId =
	| "pinned"
	| "favorited"
	| "today"
	| "previous7Days"
	| "previous30Days"
	| { kind: "month"; monthTimestamp: number }
	| { kind: "year"; year: number }
	| "archived"
	| "trashed"

const DAY_MS = 24 * 60 * 60 * 1000

// `now` is injected rather than read internally, so bucket thresholds are deterministic under
// test and the caller decides what clock to use. `compareWithinBucket` is likewise injected —
// each app keeps its own existing within-bucket tie order rather than this module picking one.
export function partitionNotesByBucket<
	T extends { id: string; pinned: boolean; favorite: boolean; archive: boolean; trash: boolean; ts: number }
>(items: readonly T[], now: number, compareWithinBucket: (a: T, b: T) => number): { bucketId: NoteBucketId; notes: T[] }[] {
	const todayAgo = now - DAY_MS
	const sevenDaysAgo = now - 7 * DAY_MS
	const thirtyDaysAgo = now - 30 * DAY_MS
	const nowDate = new Date(now)
	const twoMonthsAgo = new Date(nowDate.getFullYear(), nowDate.getMonth() - 2, nowDate.getDate()).getTime()

	const pinned: T[] = []
	const favorited: T[] = []
	const today: T[] = []
	const previous7Days: T[] = []
	const previous30Days: T[] = []
	const previousMonth: T[] = []
	const archived: T[] = []
	const trashed: T[] = []
	const yearBuckets = new Map<number, T[]>()

	for (const item of items) {
		if (item.trash) {
			trashed.push(item)
			continue
		}

		if (item.archive) {
			archived.push(item)
			continue
		}

		if (item.pinned) {
			pinned.push(item)
			continue
		}

		if (item.favorite) {
			favorited.push(item)
			continue
		}

		if (item.ts >= todayAgo) {
			today.push(item)
		} else if (item.ts >= sevenDaysAgo) {
			previous7Days.push(item)
		} else if (item.ts >= thirtyDaysAgo) {
			previous30Days.push(item)
		} else if (item.ts >= twoMonthsAgo) {
			previousMonth.push(item)
		} else {
			const year = new Date(item.ts).getFullYear()
			const bucket = yearBuckets.get(year)

			if (bucket !== undefined) {
				bucket.push(item)
			} else {
				yearBuckets.set(year, [item])
			}
		}
	}

	const result: { bucketId: NoteBucketId; notes: T[] }[] = []

	const emit = (bucketId: NoteBucketId, notes: T[]): void => {
		if (notes.length === 0) {
			return
		}

		notes.sort(compareWithinBucket)
		result.push({ bucketId, notes })
	}

	emit("pinned", pinned)
	emit("favorited", favorited)
	emit("today", today)
	emit("previous7Days", previous7Days)
	emit("previous30Days", previous30Days)
	emit({ kind: "month", monthTimestamp: twoMonthsAgo }, previousMonth)

	const years = [...yearBuckets.keys()].sort((a, b) => b - a)

	for (const year of years) {
		emit({ kind: "year", year }, yearBuckets.get(year) ?? [])
	}

	emit("archived", archived)
	emit("trashed", trashed)

	return result
}
