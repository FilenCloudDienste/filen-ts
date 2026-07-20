import { type DB } from "@op-engineering/op-sqlite"

// Pure kv range-scan helpers with no runtime dependencies, split out of sqlite.ts so the
// restore paths (queries/client.ts, lib/cache.ts) can run the REAL pager even where tests
// mock the sqlite module wholesale (e.g. the restore benchmarks).

// Exclusive upper bound for a prefix range scan over the BINARY-collated `key` column: the prefix
// with its final character incremented by one code unit. Querying `key >= prefix AND key < upper`
// uses the PRIMARY KEY index (a SEARCH), whereas `key LIKE 'prefix%'` cannot be index-optimized under
// SQLite's default case_sensitive_like = OFF and degrades to a full table scan. All current callers
// pass a non-empty prefix ending in ":".
export function prefixUpperBound(prefix: string): string {
	const lastIndex = prefix.length - 1

	// An empty prefix or one ending in U+FFFF cannot form a valid exclusive upper bound — the
	// increment wraps and the range silently matches nothing.
	if (prefix.length === 0 || prefix.charCodeAt(lastIndex) === 0xffff) {
		throw new Error("prefixUpperBound: prefix must be non-empty and must not end in U+FFFF")
	}

	return prefix.slice(0, lastIndex) + String.fromCharCode(prefix.charCodeAt(lastIndex) + 1)
}

// Rows one restore page materializes at once. Restores used to load an entire prefix range in
// a single executeRaw — on large accounts that held every row's JSON string AND its parsed
// object graph resident simultaneously, which is what exhausted the Hermes heap at boot
// (Play crash: GCBase::oom during drainJobs). Paging bounds raw-string residency to one page.
export const KV_RESTORE_PAGE_SIZE = 256

/**
 * Visit every kv row in a prefix range in key order, one bounded page at a time, yielding a
 * macrotask between pages so young-gen collections can run between parse bursts instead of
 * compounding into an evacuation OOM. Keyset pagination over the WITHOUT-ROWID primary key —
 * each page is an index-range SEARCH, no OFFSET rescans. An `onRow` throw propagates to the
 * caller mid-iteration (per-row isolation is the caller's policy, not this walker's).
 * Returns the number of rows visited.
 */
export async function forEachKvRowByPrefix(db: DB, prefix: string, onRow: (key: string, value: string) => void): Promise<number> {
	const upperBound = prefixUpperBound(prefix)

	let lastKey: string | null = null
	let total = 0

	for (;;) {
		// op-sqlite 17: executeRaw returns { rawRows, ... } — the row arrays live on .rawRows.
		const rows = (
			await db.executeRaw(
				lastKey === null
					? "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?"
					: "SELECT key, value FROM kv WHERE key > ? AND key < ? ORDER BY key LIMIT ?",
				[lastKey ?? prefix, upperBound, KV_RESTORE_PAGE_SIZE]
			)
		).rawRows

		for (const row of rows) {
			onRow(row[0] as string, row[1] as string)
		}

		total += rows.length

		const lastRow = rows[rows.length - 1]

		if (rows.length < KV_RESTORE_PAGE_SIZE || !lastRow) {
			return total
		}

		lastKey = lastRow[0] as string

		await new Promise<void>(resolve => setTimeout(resolve, 0))
	}
}
