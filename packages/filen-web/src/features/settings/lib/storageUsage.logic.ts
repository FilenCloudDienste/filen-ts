// Which rows live in the origin's storage (and so in navigator.storage.estimate()) and which on disk outside it.
const OUTSIDE_ORIGIN = new Set<string>(["browserCache", "networkDrive"])

export interface UsageInput<Row extends string> {
	// In bar order; a size of undefined is still measured, null could not be.
	rows: readonly (readonly [Row, number | null | undefined])[]
	// The origin's whole usage; undefined while asked, null when the browser does not say.
	origin: number | null | undefined
}

export interface Usage<Row extends string> {
	// Undefined until every figure is in.
	total: number | undefined
	segments: { id: Row | "other"; bytes: number }[]
}

// The bar: one segment per row with bytes, then "other" for what the origin holds beyond the measured rows (the
// database file's own pages, another build's model, leftovers no row names), floored at 0 since the browser's figure
// can lag right after a clear. The disk caches outside the origin add to the total on top.
export function storageUsage<Row extends string>({ rows, origin }: UsageInput<Row>): Usage<Row> {
	const segments: { id: Row | "other"; bytes: number }[] = []
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

		segments.push({ id, bytes })

		if (OUTSIDE_ORIGIN.has(id)) {
			outside += bytes
		} else {
			inOrigin += bytes
		}
	}

	const other = Math.max(0, (origin ?? 0) - inOrigin)

	if (other > 0) {
		segments.push({ id: "other", bytes: other })
	}

	return { total: pending ? undefined : inOrigin + other + outside, segments }
}
