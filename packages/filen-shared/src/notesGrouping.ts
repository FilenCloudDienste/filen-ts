// The notes-list date/status partition, shared by mobile's notesSorter.group and web's
// groupNotesForView. Classification core only: first-match-wins into pinned → favorited →
// today → previous 7 days → previous 30 days → calendar month(s) desc → year(s) desc → archived →
// trashed, empty buckets omitted. No labels, no icons, no row model — each app resolves its
// own header text/icon from the returned bucket id and keeps its own presentation row shape.

export type NoteBucketId =
	| "pinned"
	| "favorited"
	| "today"
	| "previous7Days"
	| "previous30Days"
	// `monthTimestamp` is local midnight on the first day of the notes' own calendar month;
	// `inCurrentYear` is false when that month lies in the previous year, so the label must name the year.
	| { kind: "month"; monthTimestamp: number; inCurrentYear: boolean }
	| { kind: "year"; year: number }
	| "archived"
	| "trashed"

const DAY_MS = 24 * 60 * 60 * 1000

// `now` is injected rather than read internally, so bucket thresholds are deterministic under
// test and the caller decides what clock to use. `compareWithinBucket` is likewise injected —
// each app keeps its own existing within-bucket tie order rather than this module picking one.
export function partitionNotesByBucket<T extends { pinned: boolean; favorite: boolean; archive: boolean; trash: boolean; ts: number }>(
	items: readonly T[],
	now: number,
	compareWithinBucket: (a: T, b: T) => number
): { bucketId: NoteBucketId; notes: T[] }[] {
	const todayAgo = now - DAY_MS
	const sevenDaysAgo = now - 7 * DAY_MS
	const thirtyDaysAgo = now - 30 * DAY_MS
	const nowDate = new Date(now)
	const nowYear = nowDate.getFullYear()
	const nowMonth = nowDate.getMonth()
	// Starts of the current calendar month and the two before it. A note older than 30 days but not
	// older than `twoMonthsBackStart` is bucketed by its own calendar month; anything older goes to
	// its year. Precomputed bounds keep the per-note work to comparisons, with no Date allocation.
	const currentMonthStart = new Date(nowYear, nowMonth, 1).getTime()
	const previousMonthStart = new Date(nowYear, nowMonth - 1, 1).getTime()
	const twoMonthsBackStart = new Date(nowYear, nowMonth - 2, 1).getTime()

	const pinned: T[] = []
	const favorited: T[] = []
	const today: T[] = []
	const previous7Days: T[] = []
	const previous30Days: T[] = []
	// Only reachable when the current month has 31 days and the note is from its first day.
	const currentMonth: T[] = []
	const previousMonth: T[] = []
	const twoMonthsBack: T[] = []
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
		} else if (item.ts >= currentMonthStart) {
			currentMonth.push(item)
		} else if (item.ts >= previousMonthStart) {
			previousMonth.push(item)
		} else if (item.ts >= twoMonthsBackStart) {
			twoMonthsBack.push(item)
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

	for (const [monthTimestamp, notes] of [
		[currentMonthStart, currentMonth],
		[previousMonthStart, previousMonth],
		[twoMonthsBackStart, twoMonthsBack]
	] as const) {
		emit({ kind: "month", monthTimestamp, inCurrentYear: new Date(monthTimestamp).getFullYear() === nowYear }, notes)
	}

	const years = [...yearBuckets.keys()].sort((a, b) => b - a)

	for (const year of years) {
		emit({ kind: "year", year }, yearBuckets.get(year) ?? [])
	}

	emit("archived", archived)
	emit("trashed", trashed)

	return result
}
