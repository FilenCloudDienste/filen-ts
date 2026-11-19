// The e2e password canary's view of the OPFS kv (e2e/helpers/passwordCanary.ts): every row whose key or stored value
// holds a needle. Values are envelope strings (@filen/shared/session), so the needle is also matched in the form JSON
// writes it in. Only the e2e hooks import this.

type EntriesPage = (prefix: string, after: string | null, limit: number) => Promise<[string, string][]>

const PAGE_ROWS = 2000

// The needle as it appears inside a JSON string literal (quotes, backslashes and control characters escaped).
function jsonEscaped(needle: string): string {
	return JSON.stringify(needle).slice(1, -1)
}

export function kvRowHolds(key: string, raw: string, needle: string): boolean {
	const escaped = jsonEscaped(needle)

	return key.includes(needle) || raw.includes(needle) || raw.includes(escaped)
}

// The keys of every row that holds the needle, read a page at a time so no single message carries the whole store.
export async function kvKeysHolding(entriesPage: EntriesPage, needle: string): Promise<string[]> {
	const found: string[] = []
	let after: string | null = null

	for (;;) {
		const rows = await entriesPage("", after, PAGE_ROWS)

		for (const [key, raw] of rows) {
			if (kvRowHolds(key, raw, needle)) {
				found.push(key)
			}
		}

		if (rows.length < PAGE_ROWS) {
			return found
		}

		after = rows.at(-1)?.[0] ?? null
	}
}
