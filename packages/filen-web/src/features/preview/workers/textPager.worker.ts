/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { decodeUnicodeText, looksLikeText } from "@filen/shared/textEncoding"
import { BlockCache } from "@/lib/media/blockCache"
import { rangePortReader, type RangePortReader } from "@/lib/media/rangePort"
import { isExecutableHead } from "@/features/preview/lib/binaryInfo/read"
import { countLines, LineIndex } from "@/features/preview/lib/textPager/index.logic"
import {
	decodeSpan,
	locateRow,
	pagerEncoding,
	rowsBefore,
	rowsFrom,
	type PagerEncoding,
	type PagerRow,
	type PagerSource
} from "@/features/preview/lib/textPager/rows.logic"
import { MatchList, searchText, type PagerScanSource, type SearchEnd } from "@/features/preview/lib/textPager/search.logic"
import {
	MboxIndex,
	headerBlock,
	messageBytes,
	readHeaderHead,
	readMessage,
	searchHeaders,
	type MboxCount,
	type MboxSearchResult
} from "@/features/preview/lib/textPager/mbox.logic"
import { readHeaderSummary, type EmailHeaderSummary } from "@/features/preview/lib/emailReading"

// One large text file's rows, line numbers and find, owned by its viewer (one worker per viewer, terminated with it):
// its bytes come over a range port into a block cache of CACHE_BLOCKS 1 MiB blocks, so what it holds is the cache, a
// scan's stretch, the line index (≤ 1 MiB) and the matches (160 KB), whatever the file's size or its lines' lengths.
// Only one scan (find, Count lines, a go to line past the counted lines) runs at a time; a new one stops it.

const CACHE_BLOCKS = 8
// A mailbox's list rows kept read (≈ 300 B each), the least recently shown dropped first.
const MBOX_ROWS_KEPT = 20_000
// Rows a list asks for at once.
const MBOX_ROWS_AT_ONCE = 500
const READ_AHEAD_BLOCKS = 2

// A Comlink proxy from the page, released once its scan ends.
type Progress = ((scanned: number, found: number, first: number) => unknown) & Partial<Comlink.ProxyMethods>

// A Comlink proxy from the page, told once the port is lost (its server went away), so an idle view learns at once.
type Lost = (() => unknown) & Partial<Comlink.ProxyMethods>

export interface PagerOpen {
	// Not a binary by its first bytes (no NUL outside UTF-16).
	readonly text: boolean
	// An executable's headers: shown as one instead of as text.
	readonly executable: boolean
	// The Unicode encoding its first block reads as; null when it is not Unicode (a codepage has to be guessed).
	readonly unicode: string | null
	// A copy of the first block, for that guess; null when not needed.
	readonly head: Uint8Array | null
}

export interface PagerRowView extends PagerRow {
	// The 1-based line it belongs to, known within the counted prefix.
	readonly line: number | null
}

export interface PagerRows {
	readonly rows: readonly PagerRowView[]
	// The row holding the offset asked for, and how many units into its text that offset is.
	readonly focus: number
	readonly column: number
}

export interface PagerLines {
	// Lines counted so far, and whether that is all of them.
	readonly lines: number
	readonly complete: boolean
	readonly frontier: number
}

export interface PagerSearch extends PagerLines {
	readonly end: SearchEnd
	readonly count: number
	// The first match at or after the offset the search was asked from (-1 for none).
	readonly first: number
}

interface Opened {
	readonly reader: RangePortReader
	readonly onLost: Lost
	readonly cache: BlockCache
	readonly source: PagerSource & PagerScanSource
}

let opened: Opened | null = null
let encoding: PagerEncoding | null = null
let index: LineIndex | null = null
let matches: MatchList | null = null
let scan: AbortController | null = null
// A mailbox's message index and list rows, made on first use.
let mbox: MboxIndex | null = null
const mboxRows = new Map<number, EmailHeaderSummary>()
// The mailbox scan running (one at a time), and the stop of a "Count all".
let mboxScan: Promise<MboxCount> | null = null
let mboxCount: AbortController | null = null

export type MboxMessage =
	| { readonly status: "ok"; readonly bytes: Uint8Array<ArrayBuffer> }
	// Past the message size cap.
	| { readonly status: "tooLarge" }
	// No such message (past the end of the file).
	| { readonly status: "missing" }

function mailbox(): MboxIndex {
	mbox ??= new MboxIndex(file().source.size)

	return mbox
}

// Scans the mailbox on until `want` messages, one scan at a time: asked while one runs, the state so far.
async function scanMailbox(want: number, signal: AbortSignal, onProgress: (count: MboxCount) => void): Promise<MboxCount> {
	const index = mailbox()

	if (mboxScan !== null) return index.state()

	mboxScan = index.scanUntil(file().source, want, signal, onProgress)

	try {
		return await mboxScan
	} finally {
		mboxScan = null
	}
}

function file(): Opened {
	if (opened === null) {
		throw new Error("no file is open")
	}

	return opened
}

function reading(): { source: PagerSource & PagerScanSource; encoding: PagerEncoding; index: LineIndex } {
	if (encoding === null || index === null) {
		throw new Error("no encoding is chosen")
	}

	return { source: file().source, encoding, index }
}

function stopScan(): void {
	scan?.abort()
	scan = null
}

function startScan(): AbortSignal {
	stopScan()
	scan = new AbortController()

	return scan.signal
}

function close(): void {
	stopScan()
	opened?.cache.dispose()
	opened?.reader.close()
	opened?.onLost[Comlink.releaseProxy]?.()
	mboxCount?.abort()
	mboxCount = null
	mbox = null
	mboxRows.clear()
	opened = null
	encoding = null
	index = null
	matches = null
}

function head(): Promise<Uint8Array> | Uint8Array {
	const { source } = file()

	return source.size === 0 ? new Uint8Array(0) : source.read(0, Math.min(source.size, BLOCK_BYTES))
}

// Lines for rows in order, from `line`, the line of the row at `known` (an index into `rows`; past the end for the row
// right after them), or from the index when that is unknown and the first row is counted. Rows past the counted prefix
// get none.
async function withLines(rows: readonly PagerRow[], known: number, line: number | null): Promise<PagerRowView[]> {
	const { source, index } = reading()
	const first = rows[0]
	let start = line

	if (start !== null) {
		for (let at = Math.min(known, rows.length) - 1; at >= 0; at--) start -= rows[at]?.breaks === true ? 1 : 0
	} else if (first !== undefined && first.start <= index.frontier) {
		start = await index.lineAt(source, first.start)
	}

	let current = start

	// Numbers only for what a scan has counted, wherever they could be followed from.
	return rows.map(row => {
		const view = { ...row, line: row.start < index.frontier ? current : null }

		if (current !== null && row.breaks) current++

		return view
	})
}

function lines(index: LineIndex): PagerLines {
	return { lines: index.lines, complete: index.complete, frontier: index.frontier }
}

// Counts lines from the frontier until `done` or the end, a block-aligned stretch at a time past the cache.
async function countUntil(done: (index: LineIndex) => boolean, signal: AbortSignal, onProgress: Progress): Promise<void> {
	const { source, index } = reading()

	await countLines(index, source, done, signal, scanned => {
		void onProgress(scanned, 0, -1)
	})
}

function isAbort(error: unknown): boolean {
	return (
		scan === null ||
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "BlockAbortError")
	)
}

// Rows `first` to `first + count` (at most MBOX_ROWS_AT_ONCE) of the list, among the messages found: sender, subject
// and date, from each message's header block, kept in an LRU.
async function mboxRowsAt(first: number, count: number): Promise<(EmailHeaderSummary | null)[]> {
	const index = mailbox()
	const { source } = file()
	const rows: (EmailHeaderSummary | null)[] = []

	for (let at = Math.max(0, first); at < Math.min(first + Math.min(count, MBOX_ROWS_AT_ONCE), index.count); at++) {
		const kept = mboxRows.get(at)

		if (kept !== undefined) {
			// Most recently shown last.
			mboxRows.delete(at)
			mboxRows.set(at, kept)
			rows.push(kept)
			continue
		}

		const span = index.span(at)

		if (span === null) {
			rows.push(null)
			continue
		}

		const block = headerBlock(await readHeaderHead(source, { start: span.start, end: span.end ?? source.size }))
		const row = block === null ? { from: null, subject: null, date: null } : await readHeaderSummary(block)

		mboxRows.set(at, row)

		if (mboxRows.size > MBOX_ROWS_KEPT) {
			const oldest = mboxRows.keys().next()

			if (oldest.done !== true) mboxRows.delete(oldest.value)
		}

		rows.push(row)
	}

	return rows
}

const api = {
	// Takes over `port` (a range port on the file's bytes) and reads the first block. `onLost` hears of the port's loss.
	open: async (port: MessagePort, size: number, onLost: Lost): Promise<PagerOpen> => {
		close()

		const reader = rangePortReader(port)

		reader.onLost(() => {
			void onLost()
		})
		const cache = new BlockCache(size, reader.readRange, { capacity: CACHE_BLOCKS, readAhead: READ_AHEAD_BLOCKS })

		opened = {
			reader,
			onLost,
			cache,
			source: {
				size,
				read: (start, end) => cache.read(start, end),
				scan: (start, end, signal) => cache.readThrough(start, end, signal)
			}
		}

		const first = await head()
		const text = looksLikeText(first)
		const unicode = decodeUnicodeText(first, { prefix: size > first.length })?.encoding ?? null

		return { text, executable: !text && isExecutableHead(first), unicode, head: unicode === null ? first.slice() : null }
	},
	// Reads the file as `label` from now on: the line index and matches start over.
	use: async (label: string): Promise<{ start: number }> => {
		stopScan()
		encoding = pagerEncoding(label, await head())
		index = new LineIndex(encoding, file().source.size)
		matches = null

		return { start: encoding.start }
	},
	// The rows around the one holding `offset`: up to `before` rows above it and `after` from it on (more above when the
	// file ends first). `line`: the line `offset` is on, when known (a match's).
	locate: async (offset: number, before: number, after: number, line: number | null): Promise<PagerRows> => {
		const { source, encoding } = reading()
		const located = await locateRow(source, encoding, offset)
		const below = await rowsFrom(source, encoding, located.start, located.continuation, after, source.size)
		const above = await rowsBefore(source, encoding, located.start, before + Math.max(0, after - below.length))
		const column = offset > located.start ? decodeSpan(await source.read(located.start, offset), encoding).length : 0

		return { rows: await withLines([...above, ...below], above.length, line), focus: above.length, column }
	},
	// Up to `count` rows from the row boundary `start` on; `line`: that row's line, when known.
	after: async (start: number, continuation: boolean, count: number, line: number | null): Promise<PagerRowView[]> => {
		const { source, encoding } = reading()

		return await withLines(await rowsFrom(source, encoding, start, continuation, count, source.size), 0, line)
	},
	// Up to `count` rows ending at the row boundary `end`; `line`: the line of the row starting there, when known.
	before: async (end: number, count: number, line: number | null): Promise<PagerRowView[]> => {
		const { source, encoding } = reading()
		// The row at `end` is one past these.
		return await withLines(await rowsBefore(source, encoding, end, count), Number.POSITIVE_INFINITY, line)
	},
	lines: (): PagerLines => lines(reading().index),
	// The 1-based line holding `offset`, when the counted prefix reaches it.
	lineOf: async (offset: number): Promise<{ readonly line: number | null; readonly frontier: number }> => {
		const { source, index } = reading()

		return { line: offset < index.frontier ? await index.lineAt(source, offset) : null, frontier: index.frontier }
	},
	// Counts every line; stopped by stop() or another scan.
	countLines: async (onProgress: Progress): Promise<PagerLines> => {
		const signal = startScan()

		await countUntil(() => false, signal, onProgress).catch((error: unknown) => {
			if (!isAbort(error)) throw error
		})
		onProgress[Comlink.releaseProxy]?.()

		return lines(reading().index)
	},
	// Where the 1-based `line` starts, counting lines up to it first; the last line's start when the file has fewer.
	// null when stopped.
	lineStart: async (line: number, onProgress: Progress): Promise<number | null> => {
		const { source, index } = reading()
		const signal = startScan()
		const reached = await countUntil(counted => counted.lines >= line, signal, onProgress).then(
			() => !signal.aborted,
			(error: unknown) => {
				if (!isAbort(error)) throw error

				return false
			}
		)

		onProgress[Comlink.releaseProxy]?.()

		return reached ? await index.lineStart(source, Math.min(line, index.lines)) : null
	},
	// Every match of `query` (at most MATCH_CAP), counting lines on the way; progress reports the matches so far and the
	// first at or after `from`.
	search: async (query: string, caseSensitive: boolean, from: number, onProgress: Progress): Promise<PagerSearch> => {
		const { source, encoding, index } = reading()
		const signal = startScan()
		const found = new MatchList()

		matches = found

		const end = await searchText({
			source,
			encoding,
			query,
			caseSensitive,
			matches: found,
			signal,
			onBytes: (bytes, base) => {
				index.feed(bytes, base)
			},
			onProgress: scanned => {
				void onProgress(scanned, found.count, found.firstFrom(from))
			}
		}).catch((error: unknown): SearchEnd => {
			if (!isAbort(error)) throw error

			return "stopped"
		})

		onProgress[Comlink.releaseProxy]?.()

		return { ...lines(index), end, count: found.count, first: found.firstFrom(from) }
	},
	match: (at: number): { offset: number; line: number } | null => matches?.at(at) ?? null,
	// The mailbox's messages found so far, scanning on until `want` (the list's rows and an overscan) or the end.
	mboxEnsure: async (want: number): Promise<MboxCount> => {
		return await scanMailbox(want, new AbortController().signal, () => undefined)
	},
	// Scans the whole mailbox; stopped by mboxStop(). Progress hears the count so far.
	mboxCountAll: async (onProgress: ((count: MboxCount) => unknown) & Partial<Comlink.ProxyMethods>): Promise<MboxCount> => {
		mboxCount?.abort()
		mboxCount = new AbortController()

		const counted = await scanMailbox(Number.POSITIVE_INFINITY, mboxCount.signal, count => {
			void onProgress(count)
		}).catch((error: unknown) => {
			if (!isAbort(error) && !(error instanceof DOMException && error.name === "AbortError")) throw error

			return mailbox().state()
		})

		onProgress[Comlink.releaseProxy]?.()
		mboxCount = null

		return counted
	},
	mboxStop: (): void => {
		mboxCount?.abort()
	},
	// Every message whose sender or subject holds `query` (at most MBOX_MATCH_CAP), finding messages as it goes; stopped
	// by mboxStop() or another search. Progress hears the messages searched and the matches so far.
	mboxSearch: async (
		query: string,
		onProgress: ((searched: number, found: number) => unknown) & Partial<Comlink.ProxyMethods>
	): Promise<MboxSearchResult> => {
		mboxCount?.abort()
		mboxCount = new AbortController()

		const signal = mboxCount.signal
		const result = await searchHeaders(query, {
			ensure: async want => {
				const index = mailbox()

				// Another scan is running (the list's): wait for it, then go on.
				while (mboxScan !== null) await mboxScan.catch(() => undefined)

				return index.count >= want || index.complete ? index.state() : await scanMailbox(want, signal, () => undefined)
			},
			row: async at => (await mboxRowsAt(at, 1))[0] ?? { from: null, subject: null },
			signal,
			onProgress: (searched, found) => {
				void onProgress(searched, found)
			}
		}).catch((error: unknown): MboxSearchResult => {
			if (!(error instanceof DOMException && error.name === "AbortError") && !isAbort(error)) throw error

			return { matches: [], end: "stopped", searched: 0 }
		})

		onProgress[Comlink.releaseProxy]?.()

		return result
	},
	// Rows `first` to `first + count` (at most MBOX_ROWS_AT_ONCE) of the list, among the messages found: sender, subject
	// and date, from each message's header block.
	mboxRows: (first: number, count: number): Promise<(EmailHeaderSummary | null)[]> => mboxRowsAt(first, count),
	// Message `index`'s own bytes (unescaped), for the message viewer; its end found first when not yet.
	mboxMessage: async (index: number): Promise<MboxMessage> => {
		const messages = mailbox()
		let span = messages.span(index)

		while (span !== null && span.end === null && !messages.complete) {
			await scanMailbox(index + 2, new AbortController().signal, () => undefined)

			span = messages.span(index)

			// Another scan was running: wait for it to move on.
			if (span?.end === null && mboxScan !== null) await mboxScan.catch(() => undefined)
		}

		if (span === null) return { status: "missing" }

		const bytes = await readMessage(
			file().source,
			{ start: span.start, end: span.end ?? file().source.size },
			new AbortController().signal
		)

		if (bytes === null) return { status: "tooLarge" }

		const message = messageBytes(bytes)

		return Comlink.transfer({ status: "ok", bytes: message }, [message.buffer])
	},
	stop: (): void => {
		stopScan()
	}
}

export type TextPagerWorkerApi = typeof api

Comlink.expose(api)
