import { BLOCK_BYTES } from "@filen/shared/videos"
import { nextBreak, type PagerEncoding, type PagerSource } from "@/features/preview/lib/textPager/rows.logic"

// Line numbers of a text file too large to hold, known only for the prefix a scan has counted (a search, a go to line,
// Count lines): checkpoints of (offset, breaks before it) every CHECKPOINT_LINES lines, and at least every
// CHECKPOINT_BYTES so finding a line never reads further than that. At most MAX_CHECKPOINTS of them (1 MiB): past that
// every other one is dropped and both steps double.

export const CHECKPOINT_LINES = 4096
export const CHECKPOINT_BYTES = BLOCK_BYTES
export const MAX_CHECKPOINTS = 65_536

// What a scan reads at a time, block-aligned so every block is downloaded once: two of them, one request.
export const SCAN_BYTES = 2 * BLOCK_BYTES

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
	from: number,
	to: number,
	visit: (bytes: Uint8Array, base: number) => boolean
): Promise<void> {
	let at = from

	while (at < to) {
		const end = Math.min(to, (Math.floor(at / BLOCK_BYTES) + 1) * BLOCK_BYTES)
		// Blocks are a multiple of every unit, so no unit straddles two pieces.
		const bytes = await source.read(at, end)

		if (!visit(bytes, at)) {
			return
		}

		at = end
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
	// How far breaks have been counted, and how many there were before that.
	private counted: number
	private breaks = 0
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
		return this.size - this.counted < this.encoding.unit
	}

	// Lines in the counted prefix (a last line without a break included once the count is complete).
	public get lines(): number {
		return this.breaks + 1
	}

	public get checkpoints(): number {
		return this.count
	}

	// Counts what `bytes` (the file's from `base`) hold past the frontier; bytes that leave a gap before it count nothing.
	// They end on a unit boundary (a scan's stretches are block-aligned) unless they end the file.
	public feed(bytes: Uint8Array, base: number): void {
		const { encoding } = this
		const from = this.counted
		const length = base + bytes.length - from

		if (base > from || length <= 0) {
			return
		}

		const end = from + length - (length % encoding.unit)
		let at = nextBreak(bytes, base, from, end, encoding)

		while (at !== -1) {
			this.checkpointUpTo(at)
			this.breaks++

			if (this.breaks - this.lastBreaks() >= this.lineStep) {
				this.push(at + encoding.unit, this.breaks)
			}

			at = nextBreak(bytes, base, at + encoding.unit, end, encoding)
		}

		this.checkpointUpTo(end)
		this.counted = end
	}

	// 1-based line number of the line holding `offset` (counted already: offset ≤ frontier); reads at most a checkpoint's
	// span.
	public async lineAt(source: PagerSource, offset: number): Promise<number> {
		const point = this.lastPointAtOrBefore(offset)
		const from = this.points[point * 2] ?? this.encoding.start
		let breaks = this.points[point * 2 + 1] ?? 0

		await eachPiece(source, from, offset, (bytes, base) => {
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

		await eachPiece(source, this.points[low * 2] ?? this.encoding.start, this.counted, (bytes, base) => {
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
