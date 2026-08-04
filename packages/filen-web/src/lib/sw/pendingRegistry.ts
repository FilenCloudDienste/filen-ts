// The service worker's registry of resolved, ready-to-stream downloads, keyed by opaque token. Split
// out of sw.ts purely so this bookkeeping is unit-testable — a worker module cannot be imported under
// node. Deliberately generic: the entry type (decrypted SDK handles) never crosses this boundary.
//
// Retention is bounded rather than explicit: entries hold decrypted key material, no page-side signal
// ever says a download finished, and an entry must survive repeated GETs (Safari probes a Range, then
// re-fetches) — so neither a completion signal nor a GET can drive eviction. Past the ceiling the LEAST
// RECENTLY READ entry goes, except one whose stream is still in flight: dropping that 404s its next
// range request mid-playback.
export class PendingRegistry<T> {
	private readonly entries = new Map<string, T>()
	// Per-id in-flight stream count: one id can be read twice at once (Safari's range probe overlapping
	// the real fetch), so this counts rather than flags.
	private readonly streams = new Map<string, number>()
	private readonly max: number
	private inFlight = 0

	public constructor(max: number) {
		this.max = max
	}

	public set(id: string, entry: T): void {
		this.entries.set(id, entry)

		if (this.entries.size <= this.max) {
			return
		}

		for (const key of this.entries.keys()) {
			// The entry just registered is never its own eviction victim; nor is one still being streamed
			// (both are, by definition, the ones in use).
			if (key === id || this.streams.has(key)) {
				continue
			}

			this.entries.delete(key)

			return
		}
	}

	// Reading an entry refreshes its recency (Map preserves insertion order, so re-inserting moves it to
	// the end) — an entry still being fetched must never be the next eviction candidate.
	public get(id: string): T | undefined {
		const entry = this.entries.get(id)

		if (entry === undefined) {
			return undefined
		}

		this.entries.delete(id)
		this.entries.set(id, entry)

		return entry
	}

	public beginStream(id: string): void {
		this.streams.set(id, (this.streams.get(id) ?? 0) + 1)
		this.inFlight++
	}

	public endStream(id: string): void {
		const count = this.streams.get(id) ?? 0

		if (count > 1) {
			this.streams.set(id, count - 1)
		} else {
			this.streams.delete(id)
		}

		this.inFlight = Math.max(0, this.inFlight - 1)
	}

	// Total streams currently being pumped, across every id — the "an update must not truncate a running
	// save" gate. In-flight counts deliberately survive clear(): those pumps still hold their own SDK
	// handles and settle on their own.
	public get activeStreams(): number {
		return this.inFlight
	}

	public get size(): number {
		return this.entries.size
	}

	public clear(): void {
		this.entries.clear()
	}
}
