/**
 * Shared faithful mock of the kv prefix-range scans issued by forEachKvRowByPrefix
 * (src/lib/sqlite.ts): first page `key >= ?`, keyset continuations `key > ?`, both with
 * `AND key < ? ORDER BY key LIMIT ?`. Ordering uses UTF-16 code-unit comparison, which is
 * equivalent to SQLite's BINARY collation for the ASCII keys the app writes.
 *
 * Usage inside a test's executeRaw stub:
 *
 *   if (isKvRangeScanQuery(query)) {
 *       return { rawRows: kvRangeScanRows(kvStore, query, params), columnNames: [], rowsAffected: 0 }
 *   }
 */

const FIRST_PAGE_PREFIX = "SELECT key, value FROM kv WHERE key >= ?"
const CONTINUATION_PREFIX = "SELECT key, value FROM kv WHERE key > ?"

export function isKvRangeScanQuery(query: string): boolean {
	return query.startsWith(FIRST_PAGE_PREFIX) || query.startsWith(CONTINUATION_PREFIX)
}

export function kvRangeScanRows(kvStore: Map<string, string>, query: string, params?: unknown[]): [string, string][] {
	const exclusiveLower = query.startsWith(CONTINUATION_PREFIX)
	const lower = params?.[0] as string
	const upper = params?.[1] as string
	const limit = typeof params?.[2] === "number" && params[2] > 0 ? (params[2] as number) : Number.POSITIVE_INFINITY
	const rows: [string, string][] = []

	for (const [key, value] of kvStore) {
		if ((exclusiveLower ? key > lower : key >= lower) && key < upper) {
			rows.push([key, value])
		}
	}

	rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

	return limit === Number.POSITIVE_INFINITY ? rows : rows.slice(0, limit)
}
