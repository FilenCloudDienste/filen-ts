import type { PagerScanSource } from "@/features/preview/lib/textPager/search.logic"
import type { PagerSource } from "@/features/preview/lib/textPager/rows.logic"
import { SCAN_BYTES } from "@/features/preview/lib/textPager/index.logic"

// A mailbox (mbox) read on demand: where its messages start, found by scanning forward only as far as asked; a message's
// header block for the list; a message's bytes, unescaped, for the message viewer.
//
// A message starts with a "From " line at the file's start or after a blank line (mboxo/mboxrd: a body line that
// begins "From " is written ">From "). Bounds: starts are kept 8 bytes a message, at most MAX_MESSAGES (past that the
// count stays "at least"); a scan reads SCAN_BYTES stretches past the cache and stops when asked; a header block is at
// most HEADER_BYTES; a message is read only up to MESSAGE_MAX_BYTES.

export const MAX_MESSAGES = 1_000_000
export const HEADER_BYTES = 16_384
export const MESSAGE_MAX_BYTES = 67_108_864

const LF = 0x0a
const CR = 0x0d
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20] // "From "

export interface MboxCount {
	readonly count: number
	// Every message found (the scan reached the end).
	readonly complete: boolean
	// More messages than are kept: the count is a floor.
	readonly capped: boolean
	// How far the scan has read.
	readonly scanned: number
}

function startsFrom(bytes: Uint8Array, at: number): boolean {
	return FROM.every((byte, k) => bytes[at + k] === byte)
}

export class MboxIndex {
	private starts = new Float64Array(1024)
	private found = 0
	// Where the next scan goes on, at a line start or inside a line.
	private frontier = 0
	// Whether the line before the frontier was blank (true at the file's start), and whether the frontier is inside a line.
	private blank = true
	private inLine = false
	private ended = false
	private full = false
	private readonly size: number

	constructor(size: number) {
		this.size = size
		this.ended = size === 0
	}

	get count(): number {
		return this.found
	}

	get complete(): boolean {
		return this.ended
	}

	state(): MboxCount {
		return { count: this.found, complete: this.ended, capped: this.full, scanned: this.frontier }
	}

	// Message `index`'s start, and where it ends: the next one's start, the file's end once complete, else null (not yet
	// found).
	span(index: number): { readonly start: number; readonly end: number | null } | null {
		if (index < 0 || index >= this.found) return null

		const next = index + 1 < this.found ? (this.starts[index + 1] ?? this.size) : this.ended ? this.size : null

		return { start: this.starts[index] ?? 0, end: next }
	}

	private record(offset: number): void {
		if (this.found >= MAX_MESSAGES) {
			this.full = true
			// Past the cap nothing more is kept or looked for.
			this.ended = true

			return
		}

		if (this.found === this.starts.length) {
			const grown = new Float64Array(Math.min(MAX_MESSAGES, this.starts.length * 2))

			grown.set(this.starts)
			this.starts = grown
		}

		this.starts[this.found++] = offset
	}

	// Takes `bytes`, the file from `base` (the frontier) on; `final` when they reach the file's end. Leaves the frontier
	// where a decision needs more bytes (a line start with fewer than five bytes after it).
	feed(bytes: Uint8Array, base: number, final: boolean): void {
		let at = 0

		if (base !== this.frontier || this.ended) return

		while (at < bytes.length) {
			if (this.inLine) {
				const newline = bytes.indexOf(LF, at)

				if (newline === -1) {
					at = bytes.length
					break
				}

				this.inLine = false
				this.blank = false
				at = newline + 1
				continue
			}

			// At a line start.
			if (!final && bytes.length - at < FROM.length) break

			if (this.blank && startsFrom(bytes, at)) {
				this.record(base + at)

				// Past the cap: nothing more is looked for.
				if (this.full) break
			}

			const newline = bytes.indexOf(LF, at)

			if (newline === -1) {
				// A line running past these bytes: not blank, whatever follows.
				this.inLine = !final
				this.blank = false
				at = bytes.length
				break
			}

			const length = newline - at

			this.blank = length === 0 || (length === 1 && bytes[at] === CR)
			at = newline + 1
		}

		this.frontier = base + at

		if (final && at >= bytes.length) this.ended = true
	}

	// Scans on until `want` messages are found, the end, or `signal`; `onProgress` hears how far it got.
	async scanUntil(
		source: PagerScanSource,
		want: number,
		signal: AbortSignal,
		onProgress: (count: MboxCount) => void
	): Promise<MboxCount> {
		while (!this.ended && this.found < want && !signal.aborted) {
			const start = this.frontier
			const end = Math.min(this.size, start + SCAN_BYTES)

			this.feed(await source.scan(start, end, signal), start, end >= this.size)
			onProgress(this.state())
		}

		return this.state()
	}
}

// Where a message's header block ends within `bytes` (the message from its "From " line on): past the first blank
// line; null when none is within them.
export function headerBlock(bytes: Uint8Array): Uint8Array | null {
	const first = bytes.indexOf(LF)

	if (first === -1) return null

	for (let at = first + 1; at < bytes.length;) {
		const newline = bytes.indexOf(LF, at)

		if (newline === -1) return null

		if (newline === at || (newline === at + 1 && bytes[at] === CR)) return bytes.subarray(first + 1, at)

		at = newline + 1
	}

	return null
}

// A message's own bytes (its "From " line dropped), with mboxrd's quoting undone: a line ">From " (one or more ">") loses
// one ">".
export function messageBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const first = bytes.indexOf(LF)
	const body = first === -1 ? new Uint8Array(0) : bytes.subarray(first + 1)
	const out = new Uint8Array(body.length)
	let length = 0

	for (let at = 0; at < body.length;) {
		const newline = body.indexOf(LF, at)
		const end = newline === -1 ? body.length : newline + 1
		let quotes = 0

		while (body[at + quotes] === 0x3e) quotes++

		const skip = quotes > 0 && startsFrom(body, at + quotes) ? 1 : 0

		out.set(body.subarray(at + skip, end), length)
		length += end - at - skip
		at = end
	}

	return length === out.length ? out : out.slice(0, length)
}

// A message's bytes as read (past the cache: a message must not evict the list's blocks), at most MESSAGE_MAX_BYTES;
// null past it.
export async function readMessage(
	source: PagerScanSource,
	span: { readonly start: number; readonly end: number },
	signal: AbortSignal
): Promise<Uint8Array | null> {
	if (span.end - span.start > MESSAGE_MAX_BYTES) return null

	return await source.scan(span.start, span.end, signal)
}

// A message's header block as read (through the cache: the list reads neighbours), at most HEADER_BYTES.
export async function readHeaderHead(source: PagerSource, span: { readonly start: number; readonly end: number }): Promise<Uint8Array> {
	return await source.read(span.start, Math.min(span.end, span.start + HEADER_BYTES))
}

// A header search's bound: matches kept (message indexes, 4 bytes each).
export const MBOX_MATCH_CAP = 10_000

export type MboxSearchEnd = "done" | "capped" | "stopped"

export interface MboxSearchResult {
	// Matching message indexes, in file order.
	readonly matches: readonly number[]
	readonly end: MboxSearchEnd
	// Messages whose headers were looked at.
	readonly searched: number
}

// Whether a list row's sender or subject holds `query` (case-insensitive, as shown).
export function headerMatches(row: { readonly from: string | null; readonly subject: string | null }, query: string): boolean {
	const needle = query.toLocaleLowerCase()

	return (row.from ?? "").toLocaleLowerCase().includes(needle) || (row.subject ?? "").toLocaleLowerCase().includes(needle)
}

export interface MboxSearchSteps {
	// Messages found so far, scanning on (at least `want` if the file has them); the index's state after.
	readonly ensure: (want: number) => Promise<MboxCount>
	// Message `index`'s list row.
	readonly row: (index: number) => Promise<{ readonly from: string | null; readonly subject: string | null }>
	readonly signal: AbortSignal
	// The messages searched, and every match so far (the same array, grown).
	readonly onProgress: (searched: number, matches: readonly number[]) => void
}

// Every message whose sender or subject holds `query`, from the first on, finding messages as it goes (the scan streams
// through the file); at most MBOX_MATCH_CAP, stopped by `signal`. Progress every PROGRESS_EVERY messages.
export async function searchHeaders(query: string, steps: MboxSearchSteps): Promise<MboxSearchResult> {
	const matches: number[] = []
	let index = 0

	for (;;) {
		if (steps.signal.aborted) return { matches, end: "stopped", searched: index }

		const state = await steps.ensure(index + 1)

		if (index >= state.count) return { matches, end: "done", searched: index }

		if (headerMatches(await steps.row(index), query)) {
			// One past the cap tells a full result from a capped one.
			if (matches.length === MBOX_MATCH_CAP) return { matches, end: "capped", searched: index }

			matches.push(index)
		}

		index++

		if (index % PROGRESS_EVERY === 0) steps.onProgress(index, matches)
	}
}

const PROGRESS_EVERY = 256
