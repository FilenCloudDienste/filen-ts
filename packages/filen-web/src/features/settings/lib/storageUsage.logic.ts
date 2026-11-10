// Which rows live in the origin's storage (and so in navigator.storage.estimate()) and which on disk outside it.
const OUTSIDE_ORIGIN = new Set<string>(["browserCache", "networkDrive"])

export interface UsageInput<Row extends string> {
	// A size of undefined is still measured, null could not be.
	rows: readonly (readonly [Row, number | null | undefined])[]
	// The origin's whole usage; undefined while asked, null when the browser does not say.
	origin: number | null | undefined
}

export interface Usage {
	// Both undefined until every figure is in.
	total: number | undefined
	other: number | undefined
}

// "Other" is what the origin holds beyond the measured rows (the database file's own pages, another build's model,
// leftovers no row names), floored at 0 since the browser's figure can lag right after a clear. The disk caches outside
// the origin add to the total on top.
export function storageUsage<Row extends string>({ rows, origin }: UsageInput<Row>): Usage {
	let pending = origin === undefined
	let inOrigin = 0
	let outside = 0

	for (const [id, bytes] of rows) {
		if (bytes === undefined) {
			pending = true

			continue
		}

		if (bytes === null || bytes <= 0) {
			continue
		}

		if (OUTSIDE_ORIGIN.has(id)) {
			outside += bytes
		} else {
			inOrigin += bytes
		}
	}

	if (pending) {
		return { total: undefined, other: undefined }
	}

	const other = Math.max(0, (origin ?? 0) - inOrigin)

	return { total: inOrigin + other + outside, other }
}
