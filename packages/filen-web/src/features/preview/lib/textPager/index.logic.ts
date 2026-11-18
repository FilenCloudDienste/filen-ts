import { BLOCK_BYTES } from "@filen/shared/videos"
import { nextBreak, type PagerEncoding, type PagerSource } from "@/features/preview/lib/textPager/rows.logic"

// Line numbers of a text file too large to hold, known only for the prefix a scan has counted (a search, a go to line,
// Count lines): checkpoints of (offset, breaks before it) every CHECKPOINT_LINES lines, and at least every
// CHECKPOINT_BYTES so finding a line never reads further than that. At most MAX_CHECKPOINTS of them (1 MiB): past that
// every other one is dropped and both steps double.

export const CHECKPOINT_LINES = 4096
export const CHECKPOINT_BYTES = BLOCK_BYTES
export const MAX_CHECKPOINTS = 65_536

// What a scan reads at a time, block-aligned so every block is downloaded once. With one more in flight ahead, a scan
// holds two of them besides the cache.
export const SCAN_BYTES = BLOCK_BYTES

// The breaks in bytes[from, to) (file offsets; `bytes` start at `base`).
export function countBreaks(bytes: Uint8Array, base: number, from: number, to: number, encoding: PagerEncoding): number {
	let count = 0
	let at = nextBreak(bytes, base, from, to, encoding)

	while (at !== -1) {
		count++
		at = nextBreak(bytes, base, at + encoding.unit, to, encoding)
	}

	return count
}

// Reads [from, to) a block at a time (views into the cache, never one large copy) and calls `visit` on each piece.
async function eachPiece(
	source: PagerSource,
	encoding: PagerEncoding,
	from: number,
	to: number,
	visit: (bytes: Uint8Array, base: number) => boolean
): Promise<void> {
	let at = from

	while (at < to) {
		const blockEnd = Math.min(to, (Math.floor(at / BLOCK_BYTES) + 1) * BLOCK_BYTES)
		// Each piece but the last ends on a unit boundary, so no break straddles two pieces.
		const cut = blockEnd < to ? blockEnd - ((blockEnd - encoding.start) % encoding.unit) : blockEnd
		const end = cut > at ? cut : Math.min(to, at + encoding.unit)
		const bytes = await source.read(at, end)

		if (!visit(bytes, at)) {
			return
		}

		at = end
	}
}

export interface PagerScanSource {
	readonly size: number
	// Bytes [start, end) read straight from the file, past the cache (a pass over the file must not evict the rows'
	// blocks). Rejects once `signal` aborts.
	scan(start: number, end: number, signal: AbortSignal): Promise<Uint8Array>
}

// The end of the block-aligned stretch a scan reads from `at`.
export function stretchEnd(at: number, size: number): number {
	return Math.min(size, (Math.floor(at / SCAN_BYTES) + 1) * SCAN_BYTES)
}

// The file's block-aligned stretches from `from` to its end, in order, with the next one's read in flight while one is
// used. Stopping early calls off that read; `signal` calls off both.
export async function* readStretches(
	source: PagerScanSource,
	from: number,
	signal: AbortSignal
): AsyncGenerator<{ readonly bytes: Uint8Array; readonly base: number }, void, undefined> {
	const ahead = new AbortController()
	const both = AbortSignal.any([signal, ahead.signal])
	const read = (at: number): Promise<Uint8Array> | null => {
		if (at >= source.size) {
			return null
		}

		const pending = source.scan(at, stretchEnd(at, source.size), both)

		// A read ahead nobody waits for (stopped early) must not surface.
		pending.catch(() => undefined)

		return pending
	}
	let at = from
	let next = read(at)

	try {
		while (next !== null) {
			const current = next
			const base = at

			at = stretchEnd(at, source.size)
			next = read(at)

			yield { bytes: await current, base }
		}
	} finally {
		ahead.abort()
	}
}

// Counts lines from the frontier until `done` or the file's end, a block-aligned stretch at a time with the next in
// flight; `onProgress` hears how far it has read.
export async function countLines(
	index: LineIndex,
	source: PagerScanSource,
	done: (index: LineIndex) => boolean,
	signal: AbortSignal,
	onProgress: (scanned: number) => void
): Promise<void> {
	const finished = (): boolean => index.complete || done(index) || signal.aborted

	if (finished()) {
		return
	}

	for await (const { bytes, base } of readStretches(source, index.frontier, signal)) {
		index.feed(bytes, base)

		// The frontier reaches every stretch's end; a scan that made none would never end.
		if (index.frontier < base + bytes.length) {
			throw new Error(`line count stuck at ${String(index.frontier)}`)
		}

		onProgress(base + bytes.length)

		if (finished()) {
			return
		}
	}
}

export interface LineIndexSteps {
	readonly lines: number
	readonly bytes: number
	readonly max: number
}

const STEPS: LineIndexSteps = { lines: CHECKPOINT_LINES, bytes: CHECKPOINT_BYTES, max: MAX_CHECKPOINTS }

export class LineIndex {
	// Pairs: a unit-aligned offset, then how many breaks come before it.
	private points: Float64Array
	private count = 0
	private lineStep: number
	private byteStep: number
	private readonly max: number
	// How far bytes have been counted, and how many breaks there were before that.
	private counted: number
	private breaks = 0
	// The start of a unit cut by the last feed's end, counted with the next feed's first bytes.
	private partial: Uint8Array = new Uint8Array(0)
	private readonly encoding: PagerEncoding
	private readonly size: number

	// `steps` other than the defaults only in tests.
	public constructor(encoding: PagerEncoding, size: number, steps?: LineIndexSteps) {
		this.encoding = encoding
		this.size = size
		this.lineStep = (steps ?? STEPS).lines
		this.byteStep = (steps ?? STEPS).bytes
		this.max = (steps ?? STEPS).max
		this.points = new Float64Array(Math.min(64, this.max * 2))
		this.counted = encoding.start
		this.push(encoding.start, 0)
	}

	// Bytes counted so far, from the file's start.
	public get frontier(): number {
		return this.counted
	}

	// Every byte is counted: `lines` is the file's.
	public get complete(): boolean {
		return this.counted >= this.size
	}

	// Lines in the counted prefix (a last line without a break included once the count is complete).
	public get lines(): number {
		return this.breaks + 1
	}

	public get checkpoints(): number {
		return this.count
	}

	// Counts what `bytes` (the file's from `base`) hold past the frontier; bytes that leave a gap before it count nothing.
	// A unit cut at their end is kept and counted with the next bytes, so the frontier always reaches their end.
	public feed(bytes: Uint8Array, base: number): void {
		const { encoding } = this
		const from = this.counted

		if (base > from || base + bytes.length <= from) {
			return
		}

		let view = bytes.subarray(from - base)
		let at = from

		if (this.partial.length > 0) {
			const unitStart = from - this.partial.length
			const unit = new Uint8Array(encoding.unit)
			const taken = Math.min(view.length, encoding.unit - this.partial.length)

			unit.set(this.partial)
			unit.set(view.subarray(0, taken), this.partial.length)

			if (this.partial.length + taken < encoding.unit) {
				this.partial = unit.slice(0, this.partial.length + taken)
				this.counted = from + taken

				return
			}

			if (nextBreak(unit, unitStart, unitStart, unitStart + 1, encoding) !== -1) {
				this.seeBreak(unitStart)
			}

			this.partial = new Uint8Array(0)
			view = view.subarray(taken)
			at = from + taken
		}

		const end = at + view.length - (view.length % encoding.unit)
		let found = nextBreak(view, at, at, end, encoding)

		while (found !== -1) {
			this.seeBreak(found)
			found = nextBreak(view, at, found + encoding.unit, end, encoding)
		}

		this.checkpointUpTo(end)
		this.partial = view.slice(end - at)
		this.counted = at + view.length
	}

	private seeBreak(at: number): void {
		this.checkpointUpTo(at)
		this.breaks++

		if (this.breaks - this.lastBreaks() >= this.lineStep) {
			this.push(at + this.encoding.unit, this.breaks)
		}
	}

	// 1-based line number of the line holding `offset` (counted already: offset ≤ frontier); reads at most a checkpoint's
	// span.
	public async lineAt(source: PagerSource, offset: number): Promise<number> {
		const point = this.lastPointAtOrBefore(offset)
		const from = this.points[point * 2] ?? this.encoding.start
		let breaks = this.points[point * 2 + 1] ?? 0

		await eachPiece(source, this.encoding, from, offset, (bytes, base) => {
			breaks += countBreaks(bytes, base, base, base + bytes.length, this.encoding)

			return true
		})

		return breaks + 1
	}

	// Where the 1-based `line` starts, when the counted prefix reaches it (null otherwise); reads at most a checkpoint's
	// span.
	public async lineStart(source: PagerSource, line: number): Promise<number | null> {
		const wanted = line - 1

		if (wanted <= 0) {
			return this.encoding.start
		}

		if (wanted > this.breaks) {
			return null
		}

		// The last checkpoint with fewer breaks before it: the wanted break is past it, and before the next.
		let low = 0
		let high = this.count - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((this.points[middle * 2 + 1] ?? 0) < wanted) low = middle
			else high = middle - 1
		}

		let breaks = this.points[low * 2 + 1] ?? 0
		let found: number | null = null

		await eachPiece(source, this.encoding, this.points[low * 2] ?? this.encoding.start, this.counted, (bytes, base) => {
			let at = nextBreak(bytes, base, base, base + bytes.length, this.encoding)

			while (at !== -1) {
				breaks++

				if (breaks === wanted) {
					found = at + this.encoding.unit

					return false
				}

				at = nextBreak(bytes, base, at + this.encoding.unit, base + bytes.length, this.encoding)
			}

			return true
		})

		return found
	}

	private lastBreaks(): number {
		return this.points[(this.count - 1) * 2 + 1] ?? 0
	}

	private lastPointAtOrBefore(offset: number): number {
		let low = 0
		let high = this.count - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((this.points[middle * 2] ?? 0) <= offset) low = middle
			else high = middle - 1
		}

		return low
	}

	// Byte-step checkpoints up to `offset`, none of whose span holds a break yet to be counted.
	private checkpointUpTo(offset: number): void {
		let last = this.points[(this.count - 1) * 2] ?? this.encoding.start

		while (offset - last >= this.byteStep) {
			last += this.byteStep
			this.push(last, this.breaks)
		}
	}

	private push(offset: number, breaks: number): void {
		if (this.count === this.max) {
			this.thin()
		}

		if (this.count * 2 === this.points.length) {
			const grown = new Float64Array(Math.min(this.points.length * 2, this.max * 2))

			grown.set(this.points)
			this.points = grown
		}

		this.points[this.count * 2] = offset
		this.points[this.count * 2 + 1] = breaks
		this.count++
	}

	// Keeps every other checkpoint (the first among them) and doubles both steps.
	private thin(): void {
		let kept = 0

		for (let index = 0; index < this.count; index += 2) {
			this.points[kept * 2] = this.points[index * 2] ?? 0
			this.points[kept * 2 + 1] = this.points[index * 2 + 1] ?? 0
			kept++
		}

		this.count = kept
		this.lineStep *= 2
		this.byteStep *= 2
	}
}
