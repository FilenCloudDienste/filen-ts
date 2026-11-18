import {
	HEADER_BYTES,
	MESSAGE_MAX_BYTES,
	MboxScanner,
	headerBlockOf,
	messageBytes,
	rowFields,
	searchHeaders,
	type MboxCount,
	type MboxRow,
	type MboxSearchResult
} from "@/features/preview/lib/textPager/mbox.logic"
import { SCAN_BYTES, type PagerScanSource } from "@/features/preview/lib/textPager/index.logic"
import type { PagerSource } from "@/features/preview/lib/textPager/rows.logic"

// One mailbox's index, list rows, count, search and message reads, in its viewer's pager worker. Every operation has a
// controller of its own: the list's scans, Count all, a search and a message open each stop alone.
//
// Requests: the index's scan reads each stretch once and captures every header block it passes (a list row costs no
// read); a row the LRU dropped reads one block through the cache; a search streams once through the file with its own
// scanner (adopted as the index when it got further); a message is read once, past the cache. The LRU holds at most
// ROWS_MAX_BYTES of rows (their strings counted at 2 bytes a unit).

const ROWS_MAX_BYTES = 6 * 1024 * 1024
const ROW_OVERHEAD = 64
// Rows read at once.
export const ROWS_AT_ONCE = 500

export type MboxMessage =
	| { readonly status: "ok"; readonly bytes: Uint8Array<ArrayBuffer> }
	// Past the message size cap.
	| { readonly status: "tooLarge" }
	// No such message, or the open was replaced by another.
	| { readonly status: "missing" }

function rowBytes(row: MboxRow): number {
	return ROW_OVERHEAD + 2 * ((row.from?.length ?? 0) + (row.subject?.length ?? 0) + (row.date?.length ?? 0))
}

function aborted(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof DOMException && error.name === "AbortError")
}

export interface MailboxSources {
	// Read through the cache (an evicted row's block).
	readonly cached: PagerSource
	// Read past the cache, in stretches.
	readonly scan: PagerScanSource
	// A header block's row (postal-mime, headers only).
	readonly parse: (block: Uint8Array) => Promise<MboxRow>
}

export class MailboxSession {
	private index: MboxScanner
	private readonly rows = new Map<number, MboxRow>()
	private rowsBytes = 0
	// The index's scan running (one at a time), and a promise settled after each of its stretches.
	private running: Promise<void> | null = null
	private stretch: { promise: Promise<void>; settle: () => void } = MailboxSession.nextStretch()
	private count: AbortController | null = null
	private search: AbortController | null = null
	private open: AbortController | null = null
	private readonly sources: MailboxSources

	constructor(sources: MailboxSources) {
		this.sources = sources
		this.index = new MboxScanner(sources.scan.size)
	}

	private static nextStretch(): { promise: Promise<void>; settle: () => void } {
		let settle = (): void => undefined
		const promise = new Promise<void>(resolve => {
			settle = resolve
		})

		return { promise, settle }
	}

	state(): MboxCount {
		return this.index.state()
	}

	private keep(index: number, row: MboxRow): void {
		const previous = this.rows.get(index)

		if (previous !== undefined) {
			this.rows.delete(index)
			this.rowsBytes -= rowBytes(previous)
		}

		this.rows.set(index, row)
		this.rowsBytes += rowBytes(row)

		for (const [oldest, dropped] of this.rows) {
			if (this.rowsBytes <= ROWS_MAX_BYTES) break

			this.rows.delete(oldest)
			this.rowsBytes -= rowBytes(dropped)
		}
	}

	private async takeCaptured(scanner: MboxScanner): Promise<void> {
		for (const { index, block } of scanner.takeCaptured()) this.keep(index, await this.sources.parse(rowFields(block)))
	}

	// Scans the index on until `done` holds or it is finished: waits out a scan another operation is running (and goes on
	// from where it left off), so no caller ever gets a stale snapshot. `signal` stops this caller's own scanning only.
	private async scanIndex(done: () => boolean, signal: AbortSignal): Promise<MboxCount> {
		while (!this.index.finished && !done() && !signal.aborted) {
			if (this.running !== null) {
				await Promise.race([this.running.catch(() => undefined), this.stretch.promise])
				continue
			}

			const scanner = this.index

			this.running = scanner.scan(this.sources.scan, done, signal, async () => {
				await this.takeCaptured(scanner)

				const passed = this.stretch

				this.stretch = MailboxSession.nextStretch()
				passed.settle()
			})

			try {
				await this.running
			} finally {
				this.running = null
				this.stretch.settle()
				this.stretch = MailboxSession.nextStretch()
			}
		}

		return this.index.state()
	}

	// The messages found so far, scanning on until `want` (the list's rows in view and beyond) or the end.
	async ensure(want: number): Promise<MboxCount> {
		return await this.scanIndex(() => this.index.count >= want, new AbortController().signal)
	}

	// Scans the whole file; stopped by stopCount(). Progress after each stretch.
	async countAll(onProgress: (count: MboxCount) => void): Promise<MboxCount> {
		this.count?.abort()

		const mine = new AbortController()

		this.count = mine

		try {
			await this.scanIndex(() => {
				onProgress(this.index.state())

				return false
			}, mine.signal)
		} catch (error) {
			if (!aborted(error, mine.signal)) throw error
		} finally {
			if (this.count === mine) this.count = null
		}

		return this.index.state()
	}

	stopCount(): void {
		this.count?.abort()
	}

	// Every message whose sender or subject holds `query` (searchHeaders); a new search stops the last. Its rows join the
	// LRU, and its scanner becomes the index when it got further. Progress hears the matches found since the last report.
	async find(query: string, onProgress: (searched: number, found: readonly number[]) => void): Promise<MboxSearchResult> {
		this.search?.abort()

		const mine = new AbortController()
		let sent = 0

		this.search = mine

		try {
			const result = await searchHeaders(query, {
				source: this.sources.scan,
				parse: this.sources.parse,
				signal: mine.signal,
				onRow: (index, row) => {
					this.keep(index, row)
				},
				onProgress: (searched, matches) => {
					onProgress(searched, matches.slice(sent))
					sent = matches.length
				}
			})

			if (this.running === null && result.scanner.scanned > this.index.scanned) {
				this.index = result.scanner
			}

			return { matches: result.matches, end: result.end, searched: result.searched }
		} finally {
			if (this.search === mine) this.search = null
		}
	}

	stopFind(): void {
		this.search?.abort()
	}

	// Row `index`: kept, else its header block read again through the cache (one block). Null past the messages found.
	private async row(index: number): Promise<MboxRow | null> {
		const kept = this.rows.get(index)

		if (kept !== undefined) {
			this.keep(index, kept)

			return kept
		}

		const span = this.index.span(index)

		if (span === null) return null

		const end = Math.min(span.end ?? this.sources.scan.size, span.start + HEADER_BYTES)
		const row = await this.sources.parse(rowFields(headerBlockOf(await this.sources.cached.read(span.start, end))))

		this.keep(index, row)

		return row
	}

	// Rows `first` to `first + count` (at most ROWS_AT_ONCE).
	async rowsFrom(first: number, count: number): Promise<(MboxRow | null)[]> {
		const out: (MboxRow | null)[] = []

		for (let at = Math.max(0, first); at < Math.min(first + Math.min(count, ROWS_AT_ONCE), this.index.count); at++)
			out.push(await this.row(at))

		return out
	}

	// The rows of the messages `indexes` names (a search's matches), in that order.
	async rowsOf(indexes: readonly number[]): Promise<(MboxRow | null)[]> {
		const out: (MboxRow | null)[] = []

		for (const index of indexes.slice(0, ROWS_AT_ONCE)) out.push(await this.row(index))

		return out
	}

	// Message `index`'s own bytes, unquoted. Its end is looked for at most MESSAGE_MAX_BYTES and a stretch past its start;
	// a later open stops this one.
	async message(index: number): Promise<MboxMessage> {
		this.open?.abort()

		const mine = new AbortController()

		this.open = mine

		try {
			const found = (): { start: number; end: number | null } | null => this.index.span(index)
			// Its start found, then its end, or the bound past its start.
			const known = (): boolean => {
				const span = found()

				return span !== null && (span.end !== null || this.index.scanned - span.start > MESSAGE_MAX_BYTES + SCAN_BYTES)
			}

			if (!known()) await this.scanIndex(known, mine.signal)

			const span = found()

			if (mine.signal.aborted || span === null) return { status: "missing" }
			if (span.end === null || span.end - span.start > MESSAGE_MAX_BYTES) return { status: "tooLarge" }

			// The scan's own buffer, compacted in place: the message is held once.
			const read = await this.sources.scan.scan(span.start, span.end, mine.signal)

			return { status: "ok", bytes: messageBytes(read as Uint8Array<ArrayBuffer>) }
		} catch (error) {
			if (aborted(error, mine.signal)) return { status: "missing" }

			throw error
		} finally {
			if (this.open === mine) this.open = null
		}
	}

	close(): void {
		this.count?.abort()
		this.search?.abort()
		this.open?.abort()
		this.rows.clear()
		this.rowsBytes = 0
	}
}
