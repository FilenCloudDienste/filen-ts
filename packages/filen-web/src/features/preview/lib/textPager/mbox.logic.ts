import { readStretches, type PagerScanSource } from "@/features/preview/lib/textPager/index.logic"

// A mailbox (mbox) read on demand: where its messages start, found by scanning forward only as far as asked, with each
// message's header block captured from the bytes the scan already holds; a message's bytes, unquoted, for the message
// viewer.
//
// A message starts at a "From " line at the file's start or after a blank line, whose shape is a separator's (a sender,
// then an asctime date, as mutt checks: a body line "From …" a writer did not quote stays body text). Content-Length is
// never honoured: a sender can set it to swallow the messages after it.
//
// Bounds: starts are kept 8 bytes a message, at most MAX_MESSAGES (then the count is "capped" and the last message ends
// where the next would start); a scan reads the file in block-aligned stretches past the cache, one in flight ahead, and
// stops when asked; of a header block only its row fields (sender, subject, date) are kept, up to HEADER_BYTES, looked for
// through its first HEADER_SCAN_BYTES; a line is carried across stretches up to HEADER_BYTES; a message is read only up
// to MESSAGE_MAX_BYTES.

export const MAX_MESSAGES = 1_000_000
// A header block's row fields kept, and how far into a long header (Received and ARC chains) they are looked for.
export const HEADER_BYTES = 65_536
export const HEADER_SCAN_BYTES = 1_048_576
export const MESSAGE_MAX_BYTES = 67_108_864

const LF = 0x0a
const CR = 0x0d
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20] // "From "
// The part of a "From " line its shape is judged on.
const SEPARATOR_PROBE = 1024
// "From <sender> [Www[,]] Mmm dd hh:mm[:ss] [zone] yyyy", the sender plain or quoted. Linear: no nested repeats.
const SEPARATOR =
	/^From (?:"[^"]*"\S*|\S+)[ \t]+(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?[ \t]+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+\d{1,2}[ \t]+\d{1,2}:\d{2}(?::\d{2})?[ \t]+(?:(?:[A-Z]{1,5}|[+-]\d{4})[ \t]+)?\d{4}/

export interface MboxCount {
	readonly count: number
	// Every message found: the scan reached the file's end.
	readonly complete: boolean
	// More messages than are kept: the count is a floor, and nothing more is looked for.
	readonly capped: boolean
	// How far the scan has read.
	readonly scanned: number
}

export interface CapturedHeader {
	readonly index: number
	// The message's row field lines (From, Subject, Date and their folded continuations), at most HEADER_BYTES.
	readonly block: Uint8Array
}

function startsFrom(bytes: Uint8Array, at: number): boolean {
	return FROM.every((byte, k) => bytes[at + k] === byte)
}

// Whether a "From " line (without its line break) has a separator's shape.
export function isSeparator(line: Uint8Array): boolean {
	if (!startsFrom(line, 0)) return false

	let text = ""

	for (let k = 0; k < Math.min(line.length, SEPARATOR_PROBE); k++) text += String.fromCharCode(line[k] ?? 0)

	return SEPARATOR.test(text)
}

// A header line naming a field a list row shows.
function isRowField(line: Uint8Array): boolean {
	let name = ""

	for (let k = 0; k < Math.min(line.length, 8); k++) name += String.fromCharCode(line[k] ?? 0)

	return /^(?:from|subject|date):/i.test(name)
}

function joined(parts: readonly Uint8Array[], length: number): Uint8Array {
	const out = new Uint8Array(length)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

export class MboxScanner {
	private starts = new Float64Array(1024)
	private found = 0
	private frontier = 0
	// Whether the line before the frontier was blank (true at the file's start).
	private blank = true
	private ended = false
	private full = false
	// Where the message after the last kept one starts, once the cap is reached.
	private capEnd = 0
	// A line begun in an earlier stretch: its start, its first bytes (up to HEADER_BYTES), its whole length so far.
	private partial: { start: number; parts: Uint8Array[]; kept: number; length: number } | null = null
	// The header block being captured: its row field lines (and their folded continuations), and how much of it was seen.
	private header: { index: number; parts: Uint8Array[]; length: number; seen: number; keeping: boolean } | null = null
	private captured: CapturedHeader[] = []
	readonly size: number

	constructor(size: number) {
		this.size = size
		this.ended = size === 0
	}

	get count(): number {
		return this.found
	}

	get scanned(): number {
		return this.frontier
	}

	// No more is looked for: the end was reached, or the cap.
	get finished(): boolean {
		return this.ended
	}

	state(): MboxCount {
		return { count: this.found, complete: this.ended && !this.full, capped: this.full, scanned: this.frontier }
	}

	// Message `index`'s start, and where it ends: the next one's start, the file's end once read, the cap's next start;
	// else null (not yet found).
	span(index: number): { readonly start: number; readonly end: number | null } | null {
		if (index < 0 || index >= this.found) return null

		const end = index + 1 < this.found ? (this.starts[index + 1] ?? this.size) : this.full ? this.capEnd : this.ended ? this.size : null

		return { start: this.starts[index] ?? 0, end }
	}

	// The header blocks captured since the last call.
	takeCaptured(): CapturedHeader[] {
		const taken = this.captured

		this.captured = []

		return taken
	}

	private finishHeader(): void {
		if (this.header !== null) {
			this.captured.push({ index: this.header.index, block: joined(this.header.parts, this.header.length) })
			this.header = null
		}
	}

	private record(offset: number): void {
		if (this.found >= MAX_MESSAGES) {
			this.full = true
			this.ended = true
			this.capEnd = offset

			return
		}

		if (this.found === this.starts.length) {
			const grown = new Float64Array(Math.min(MAX_MESSAGES, this.starts.length * 2))

			grown.set(this.starts)
			this.starts = grown
		}

		this.starts[this.found++] = offset
	}

	// One line: `bytes` its first bytes (up to HEADER_BYTES, no line break), `length` its whole length.
	private line(bytes: Uint8Array, start: number, length: number): void {
		const empty = length === 0 || (length === 1 && bytes[0] === CR)

		if (this.blank && startsFrom(bytes, 0) && isSeparator(bytes)) {
			this.finishHeader()
			this.record(start)

			if (!this.ended) this.header = { index: this.found - 1, parts: [], length: 0, seen: 0, keeping: false }
		} else if (this.header !== null) {
			const header = this.header

			header.seen += length + 1

			if (empty || header.seen > HEADER_SCAN_BYTES) {
				this.finishHeader()
			} else {
				const first = bytes[0] ?? 0

				// A folded line continues the field before it.
				if (first !== 0x20 && first !== 0x09) header.keeping = isRowField(bytes)

				if (header.keeping && header.length + bytes.length + 1 <= HEADER_BYTES) {
					header.parts.push(bytes.slice(), Uint8Array.of(LF))
					header.length += bytes.length + 1
				}
			}
		}

		this.blank = empty
	}

	private endPartial(rest: Uint8Array, restLength: number): void {
		const partial = this.partial

		if (partial === null) return

		const room = Math.max(0, HEADER_BYTES - partial.kept)
		const kept = rest.subarray(0, room)

		this.line(joined([...partial.parts, kept], partial.kept + kept.length), partial.start, partial.length + restLength)
		this.partial = null
	}

	// Takes the stretch `bytes` at `base` (the frontier): every line it ends, and the start of one it does not.
	feed(bytes: Uint8Array, base: number): void {
		if (base !== this.frontier || this.ended) return

		let at = 0

		if (this.partial !== null) {
			const newline = bytes.indexOf(LF)

			if (newline === -1) {
				const room = Math.max(0, HEADER_BYTES - this.partial.kept)

				if (room > 0) {
					this.partial.parts.push(bytes.slice(0, room))
					this.partial.kept += Math.min(room, bytes.length)
				}

				this.partial.length += bytes.length
				at = bytes.length
			} else {
				this.endPartial(bytes.subarray(0, newline), newline)
				at = newline + 1
			}
		}

		while (at < bytes.length && !this.finished) {
			const newline = bytes.indexOf(LF, at)

			if (newline === -1) {
				const kept = bytes.slice(at, Math.min(bytes.length, at + HEADER_BYTES))

				this.partial = { start: base + at, parts: [kept], kept: kept.length, length: bytes.length - at }
				break
			}

			this.line(bytes.subarray(at, Math.min(newline, at + HEADER_BYTES)), base + at, newline - at)
			at = newline + 1
		}

		this.frontier = base + bytes.length

		if (this.frontier >= this.size && !this.finished) {
			this.endPartial(new Uint8Array(0), 0)
			this.finishHeader()
			this.ended = true
		}
	}

	// Scans on, a block-aligned stretch at a time with the next in flight, until `done` holds, the end or the cap, or
	// `signal`; `onStretch` runs after each stretch (to take what it captured).
	async scan(source: PagerScanSource, done: () => boolean, signal: AbortSignal, onStretch: () => Promise<void> | void): Promise<void> {
		if (this.ended || done()) return

		for await (const { bytes, base } of readStretches(source, this.frontier, signal)) {
			this.feed(bytes, base)
			await onStretch()

			if (this.finished || done()) return
		}
	}
}

// The header fields a list row shows (From, Subject, Date, with their folded continuations), out of a header block:
// only whole lines, so a block cut at its cap still yields what it holds.
export function rowFields(block: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = []
	let length = 0
	let keeping = false

	for (let at = 0; at < block.length;) {
		const newline = block.indexOf(LF, at)

		if (newline === -1) break

		const first = block[at] ?? 0

		if (first !== 0x20 && first !== 0x09) keeping = isRowField(block.subarray(at, newline))

		if (keeping) {
			parts.push(block.subarray(at, newline + 1))
			length += newline + 1 - at
		}

		at = newline + 1
	}

	return joined(parts, length)
}

// A message's header block, from bytes that start at its "From " line: the lines up to the first blank one, at most
// HEADER_BYTES (an evicted row read again).
export function headerBlockOf(bytes: Uint8Array): Uint8Array {
	const first = bytes.indexOf(LF)

	if (first === -1) return new Uint8Array(0)

	for (let at = first + 1; at < bytes.length;) {
		const newline = bytes.indexOf(LF, at)

		if (newline === -1) return bytes.subarray(first + 1, at)

		if (newline === at || (newline === at + 1 && bytes[at] === CR)) return bytes.subarray(first + 1, at)

		at = newline + 1
	}

	return bytes.subarray(first + 1)
}

// A message's own bytes (its "From " line dropped), with mboxrd's quoting undone (a line ">From " loses one ">"),
// compacted in place in `bytes` (the scan's own buffer: writes trail reads), so the message is held once.
export function messageBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	const first = bytes.indexOf(LF)

	if (first === -1) return bytes.subarray(0, 0)

	let length = 0

	for (let at = first + 1; at < bytes.length;) {
		const newline = bytes.indexOf(LF, at)
		const end = newline === -1 ? bytes.length : newline + 1
		let quotes = 0

		while (bytes[at + quotes] === 0x3e) quotes++

		const from = at + (quotes > 0 && startsFrom(bytes, at + quotes) ? 1 : 0)

		bytes.copyWithin(length, from, end)
		length += end - from
		at = end
	}

	return bytes.subarray(0, length)
}

// A header search's bound: matches kept (message indexes).
export const MBOX_MATCH_CAP = 10_000

export type MboxSearchEnd = "done" | "capped" | "stopped"

export interface MboxSearchResult {
	// Matching message indexes, in file order.
	readonly matches: readonly number[]
	readonly end: MboxSearchEnd
	// Messages whose headers were looked at.
	readonly searched: number
}

export interface MboxRow {
	readonly from: string | null
	readonly subject: string | null
	readonly date: string | null
}

// Whether a list row's sender or subject holds `query` (case-insensitive, as shown).
export function headerMatches(row: Pick<MboxRow, "from" | "subject">, query: string): boolean {
	const needle = query.toLocaleLowerCase()

	return (row.from ?? "").toLocaleLowerCase().includes(needle) || (row.subject ?? "").toLocaleLowerCase().includes(needle)
}

export interface MboxSearchSteps {
	readonly source: PagerScanSource
	// A captured header block's row.
	readonly parse: (block: Uint8Array) => Promise<MboxRow>
	readonly signal: AbortSignal
	// Each row the search reads (for the list to keep).
	readonly onRow?: (index: number, row: MboxRow) => void
	// After each stretch: the messages searched, and every match so far (the same array, grown).
	readonly onProgress: (searched: number, matches: readonly number[]) => void
}

// Every message whose sender or subject holds `query`, streaming once through the file with a scanner of its own (its
// rows taken from the header blocks the scan captures: one read a stretch, nothing read twice); at most MBOX_MATCH_CAP
// (one past it says "capped"), the matches found so far kept when stopped. Returns its scanner too, which by then knows
// at least as much as any other.
export async function searchHeaders(query: string, steps: MboxSearchSteps): Promise<MboxSearchResult & { readonly scanner: MboxScanner }> {
	const scanner = new MboxScanner(steps.source.size)
	const matches: number[] = []
	let searched = 0
	// Set from the scan's callback: held in an object so its reads after the scan see it.
	const cap = { overflow: false }

	try {
		await scanner.scan(
			steps.source,
			() => cap.overflow,
			steps.signal,
			async () => {
				for (const { index, block } of scanner.takeCaptured()) {
					const row = await steps.parse(rowFields(block))

					steps.onRow?.(index, row)
					searched = index + 1

					if (headerMatches(row, query)) {
						if (matches.length === MBOX_MATCH_CAP) {
							cap.overflow = true
							break
						}

						matches.push(index)
					}
				}

				steps.onProgress(searched, matches)
			}
		)
	} catch (error) {
		if (!steps.signal.aborted) throw error
	}

	const end: MboxSearchEnd = steps.signal.aborted ? "stopped" : cap.overflow || scanner.state().capped ? "capped" : "done"

	return { matches, end, searched, scanner }
}
