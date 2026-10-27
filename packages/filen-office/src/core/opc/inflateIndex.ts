import { sliceClock, type Slicing } from "../slicing"
import { crc32 } from "./crc32"
import { ZipError } from "./errors"

// Random access into a deflated zip entry (a video a presentation carries compressed): a raw DEFLATE decoder (RFC
// 1951) that records, every `every` bytes of output, the state it needs to start again there: the input bit, the
// block it is in (a stored block's remaining length, or a Huffman block's code lengths) and the last 32 KiB of
// output, the dictionary any later back-reference may reach. A read then inflates from the nearest checkpoint at or
// before it, so it costs at most `every` bytes of output work on top of what it returns, and the whole entry is
// never held. fflate and DecompressionStream cannot start mid-stream, hence this decoder.

const WINDOW = 32_768
// Output decoded between hand-overs (the window is kept in front of it for back-references).
const CHUNK = 256 * 1024
const MAX_MATCH = 258
// Input kept ahead of decoding (a dynamic block header needs at most about 600 bytes), except at the stream's end.
const MARGIN = 1024
// Compressed bytes read per request.
const INPUT_STEP = 256 * 1024
// Zero bytes after the input, so bit reads past its end stay in bounds.
const PAD = 16

export const INFLATE_CHECKPOINT_BYTES = 2 * 1024 * 1024
// Block headers one decode() call parses before it hands back (so the slice clock is looked at between them: a
// stream of empty blocks produces no output to stop on).
const HEADERS_PER_DECODE = 64
// Output between progress reports of a build.
const PROGRESS_BYTES = 1024 * 1024

const LENGTH_BASE = Uint16Array.of(
	3,
	4,
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	13,
	15,
	17,
	19,
	23,
	27,
	31,
	35,
	43,
	51,
	59,
	67,
	83,
	99,
	115,
	131,
	163,
	195,
	227,
	258
)
const LENGTH_EXTRA = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0)
const DISTANCE_BASE = Uint16Array.of(
	1,
	2,
	3,
	4,
	5,
	7,
	9,
	13,
	17,
	25,
	33,
	49,
	65,
	97,
	129,
	193,
	257,
	385,
	513,
	769,
	1025,
	1537,
	2049,
	3073,
	4097,
	6145,
	8193,
	12_289,
	16_385,
	24_577
)
const DISTANCE_EXTRA = Uint8Array.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13)
// The order code length code lengths are sent in (RFC 1951 §3.2.7).
const CODE_LENGTH_ORDER = Uint8Array.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15)

// The fixed code's lengths (RFC 1951 §3.2.6): 288 literal/length codes, then 32 distance codes.
const FIXED_LENGTHS = (() => {
	const lengths = new Uint8Array(320)

	lengths.fill(8, 0, 144)
	lengths.fill(9, 144, 256)
	lengths.fill(7, 256, 280)
	lengths.fill(8, 280, 288)
	lengths.fill(5, 288, 320)

	return lengths
})()

// Where the decoder is in the stream.
const Mode = { Header: 0, Huffman: 1, Stored: 2, Done: 3 } as const

type Mode = (typeof Mode)[keyof typeof Mode]

// Why decode() stopped: the output buffer is full (hand over what is pending, then slide), `produced` (or the input
// read) reached the target given, more input is needed, the final block ended, or its header budget is spent.
const Stop = { Full: 0, Target: 1, Input: 2, End: 3, Budget: 4 } as const

type Stop = (typeof Stop)[keyof typeof Stop]

// Where decoding can start again: `out` bytes produced, at input bit `bit`, in `mode`.
export interface InflateCheckpoint {
	readonly out: number
	readonly bit: number
	readonly mode: 0 | 1 | 2
	readonly final: boolean
	// Stored: bytes left in the block.
	readonly stored: number
	// Huffman: the block's code lengths (literal/length then distance), undefined for the fixed code.
	readonly lengths: Uint8Array | undefined
	readonly literals: number
	// The output's last min(out, 32 KiB) bytes.
	readonly window: Uint8Array
}

// The compressed bytes of the entry: [offset, offset + length) of its deflate stream.
export interface InflateInput {
	readonly size: number
	read(offset: number, length: number): Promise<Uint8Array>
}

// The most compressed bytes a deflate stream of `size` bytes needs: every block stored (5 bytes of header per block
// of up to 65,535 bytes), with room for encoders that store shorter blocks and for a few headers and padding. A
// longer stream carries input that inflates to nothing (empty blocks), which only costs the reader time.
export function deflateBound(size: number): number {
	return size + 5 * Math.ceil(size / 16_383) + 1024
}

function corrupt(what: string): ZipError {
	return new ZipError("corrupt", `Damaged deflate data: ${what}`)
}

// A canonical Huffman decoding table (RFC 1951 §3.2.2) for lengths[from, from + count): indexed by the next `bits`
// input bits (least significant first), each entry symbol << 4 | code length (0: no code). Returns `bits`.
function buildTable(lengths: Uint8Array, from: number, count: number, table: Uint16Array): number {
	const counts = new Uint16Array(16)
	let max = 0

	for (let k = 0; k < count; k++) {
		const length = lengths[from + k] as number

		counts[length] = (counts[length] as number) + 1

		if (length > max) max = length
	}

	counts[0] = 0

	const next = new Uint16Array(16)
	let code = 0
	let left = 1

	for (let length = 1; length <= 15; length++) {
		left = (left << 1) - (counts[length] as number)

		if (left < 0) throw corrupt("an over-subscribed code")

		code = (code + (counts[length - 1] as number)) << 1
		next[length] = code
	}

	const bits = Math.max(1, max)
	const size = 1 << bits

	table.fill(0, 0, size)

	for (let symbol = 0; symbol < count; symbol++) {
		const length = lengths[from + symbol] as number

		if (length === 0) continue

		const assigned = next[length] as number

		next[length] = assigned + 1

		// The code's bits reversed: the stream sends Huffman codes most significant bit first.
		let reversed = 0

		for (let k = 0; k < length; k++) reversed |= ((assigned >>> k) & 1) << (length - 1 - k)

		const entry = (symbol << 4) | length

		for (let at = reversed; at < size; at += 1 << length) table[at] = entry
	}

	return bits
}

// One decoding run: input buffered from the compressed stream, output in a buffer whose first WINDOW bytes (once
// that much was produced) are the history back-references reach.
class Inflater {
	readonly input: InflateInput
	// Input: buf[0, valid) holds compressed bytes from `base`, then PAD zero bytes.
	private buf = new Uint8Array(PAD)
	private base = 0
	private valid = 0
	// Bit position in buf.
	private pos = 0
	// Output.
	readonly out = new Uint8Array(WINDOW + CHUNK)
	// Write index in `out`, and where the bytes not yet handed over start.
	o = 0
	pending = 0
	produced = 0
	private mode: Mode = Mode.Header
	private final = false
	private stored = 0
	private lengths: Uint8Array | undefined
	private literals = 0
	private readonly literalTable = new Uint16Array(1 << 15)
	private readonly distanceTable = new Uint16Array(1 << 15)
	private literalBits = 0
	private distanceBits = 0
	// The tables hold the fixed code (built once per decoder however many fixed blocks follow).
	private fixedTables = false

	constructor(input: InflateInput, from?: InflateCheckpoint) {
		this.input = input

		if (from === undefined) return

		// Not >>> and &: past 512 MiB of input the bit offset is over 2^32.
		this.base = Math.floor(from.bit / 8)
		this.pos = from.bit % 8
		this.produced = from.out
		this.mode = from.mode
		this.final = from.final
		this.stored = from.stored
		this.out.set(from.window, 0)
		this.o = from.window.length
		this.pending = this.o

		if (from.mode === Mode.Huffman) this.tables(from.lengths ?? FIXED_LENGTHS, from.lengths === undefined ? 288 : from.literals)
	}

	get done(): boolean {
		return this.mode === Mode.Done
	}

	get inputEnd(): boolean {
		return this.base + this.valid >= this.input.size
	}

	// The input bit decoding is at.
	get bit(): number {
		return this.base * 8 + this.pos
	}

	// The state here, as a checkpoint (only between symbols, where decode() stops).
	checkpoint(): InflateCheckpoint {
		const keep = Math.min(this.o, WINDOW)

		return {
			out: this.produced,
			bit: this.base * 8 + this.pos,
			mode: this.mode === Mode.Done ? Mode.Header : this.mode,
			final: this.final,
			stored: this.stored,
			lengths: this.mode === Mode.Huffman ? this.lengths : undefined,
			literals: this.literals,
			window: this.out.slice(this.o - keep, this.o)
		}
	}

	// Reads more input: what is left of the buffer and the next INPUT_STEP bytes.
	async fill(): Promise<void> {
		const consumed = this.pos >>> 3
		const start = this.base + consumed
		const left = this.valid - consumed
		const take = Math.min(INPUT_STEP, this.input.size - (this.base + this.valid))

		if (take <= 0) throw corrupt("the stream ends early")

		const more = await this.input.read(this.base + this.valid, take)

		if (more.length !== take) throw corrupt("a short read")

		const next = new Uint8Array(left + take + PAD)

		next.set(this.buf.subarray(consumed, this.valid), 0)
		next.set(more, left)
		this.buf = next
		this.base = start
		this.valid = left + take
		this.pos &= 7
	}

	// Keeps the last WINDOW bytes of output in front, once everything pending was handed over.
	slide(): void {
		if (this.o <= WINDOW) return

		this.out.copyWithin(0, this.o - WINDOW, this.o)
		this.o = WINDOW
		this.pending = WINDOW
	}

	private tables(lengths: Uint8Array, literals: number): void {
		const fixed = lengths === FIXED_LENGTHS

		this.lengths = fixed ? undefined : lengths
		this.literals = literals

		if (fixed && this.fixedTables) return

		this.fixedTables = fixed
		this.literalBits = buildTable(lengths, 0, literals, this.literalTable)
		this.distanceBits = buildTable(lengths, literals, lengths === FIXED_LENGTHS ? 32 : lengths.length - literals, this.distanceTable)
	}

	private bits(count: number): number {
		const pos = this.pos
		const at = pos >>> 3
		const buf = this.buf
		const word = ((buf[at] as number) | ((buf[at + 1] as number) << 8) | ((buf[at + 2] as number) << 16)) >>> (pos & 7)

		this.pos = pos + count

		return word & ((1 << count) - 1)
	}

	// Reads a dynamic block's code lengths (RFC 1951 §3.2.7) and builds its tables.
	private dynamicHeader(): void {
		const literals = this.bits(5) + 257
		const distances = this.bits(5) + 1
		const codes = this.bits(4) + 4

		if (literals > 286 || distances > 30) throw corrupt("too many codes")

		const codeLengths = new Uint8Array(19)

		for (let k = 0; k < codes; k++) codeLengths[CODE_LENGTH_ORDER[k] as number] = this.bits(3)

		const table = new Uint16Array(1 << 7)
		const bits = buildTable(codeLengths, 0, 19, table)
		const mask = (1 << bits) - 1
		const total = literals + distances
		const lengths = new Uint8Array(total)

		for (let k = 0; k < total;) {
			const pos = this.pos
			const at = pos >>> 3
			const word =
				((this.buf[at] as number) | ((this.buf[at + 1] as number) << 8) | ((this.buf[at + 2] as number) << 16)) >>> (pos & 7)
			const entry = table[word & mask] as number
			const length = entry & 15

			if (length === 0) throw corrupt("an unknown code length code")

			this.pos = pos + length

			const symbol = entry >>> 4

			if (symbol < 16) {
				lengths[k++] = symbol

				continue
			}

			let value = 0
			let repeat: number

			if (symbol === 16) {
				if (k === 0) throw corrupt("a repeat with nothing before it")

				value = lengths[k - 1] as number
				repeat = 3 + this.bits(2)
			} else if (symbol === 17) repeat = 3 + this.bits(3)
			else repeat = 11 + this.bits(7)

			if (k + repeat > total) throw corrupt("code lengths past the codes")

			lengths.fill(value, k, k + repeat)
			k += repeat
		}

		if (lengths[256] === 0) throw corrupt("no end-of-block code")

		this.tables(lengths, literals)
	}

	// Decodes until a Stop. Stops only between symbols, so the state is a checkpoint wherever it stops. `inputTarget`:
	// an input bit at which it stops (Target) before the next block header.
	decode(target: number, inputTarget = Infinity): Stop {
		const out = this.out
		const full = out.length - MAX_MATCH
		let headers = 0

		for (;;) {
			if (this.mode === Mode.Done) return Stop.End
			if (this.produced >= target) return Stop.Target
			if (this.o >= full) return Stop.Full

			const available = this.valid - (this.pos >>> 3)
			const end = this.inputEnd

			if (this.mode === Mode.Header) {
				if (this.bit >= inputTarget) return Stop.Target
				if (headers === HEADERS_PER_DECODE) return Stop.Budget
				if (available < MARGIN && !end) return Stop.Input
				if (available <= 0) throw corrupt("the stream ends early")

				headers++

				this.final = this.bits(1) === 1

				const type = this.bits(2)

				if (type === 0) {
					this.pos = (this.pos + 7) & ~7

					const at = this.pos >>> 3
					const buf = this.buf
					const length = (buf[at] as number) | ((buf[at + 1] as number) << 8)
					const check = (buf[at + 2] as number) | ((buf[at + 3] as number) << 8)

					if ((length ^ 0xffff) !== check) throw corrupt("a stored block's length check")

					this.pos += 32
					this.stored = length
					this.mode = Mode.Stored
				} else if (type === 1) {
					this.tables(FIXED_LENGTHS, 288)
					this.mode = Mode.Huffman
				} else if (type === 2) {
					this.dynamicHeader()
					this.mode = Mode.Huffman
				} else throw corrupt("block type 3")

				if (this.pos > this.valid * 8) throw corrupt("the stream ends early")

				continue
			}

			if (this.mode === Mode.Stored) {
				if (this.stored === 0) {
					this.mode = this.final ? Mode.Done : Mode.Header

					continue
				}

				const at = this.pos >>> 3
				const count = Math.min(this.stored, available, full + MAX_MATCH - this.o, target - this.produced)

				if (count <= 0) {
					if (end) throw corrupt("the stream ends early")

					return Stop.Input
				}

				out.set(this.buf.subarray(at, at + count), this.o)
				this.o += count
				this.produced += count
				this.pos += count * 8
				this.stored -= count

				continue
			}

			if (available < MARGIN && !end) return Stop.Input

			// The Huffman loop: locals for speed, written back when it stops.
			const buf = this.buf
			const literalTable = this.literalTable
			const distanceTable = this.distanceTable
			const literalMask = (1 << this.literalBits) - 1
			const distanceMask = (1 << this.distanceBits) - 1
			// Input bits that may be consumed before stopping for more (the last symbol may take 48 bits).
			const limit = end ? (this.valid + PAD - 9) * 8 : (this.valid - 9) * 8
			const outStart = this.o
			let pos = this.pos
			let o = this.o
			const stopAt = Math.min(full, o + (target - this.produced))
			let blockEnd = false

			while (o < stopAt && pos < limit) {
				let at = pos >>> 3
				let word = ((buf[at] as number) | ((buf[at + 1] as number) << 8) | ((buf[at + 2] as number) << 16)) >>> (pos & 7)
				const entry = literalTable[word & literalMask] as number
				const length = entry & 15

				if (length === 0) throw corrupt("an unknown literal/length code")

				pos += length

				const symbol = entry >>> 4

				if (symbol < 256) {
					out[o++] = symbol

					continue
				}

				if (symbol === 256) {
					blockEnd = true

					break
				}

				const index = symbol - 257

				if (index > 28) throw corrupt("an invalid length code")

				let copy = LENGTH_BASE[index] as number
				const extra = LENGTH_EXTRA[index] as number

				if (extra > 0) {
					at = pos >>> 3
					word = ((buf[at] as number) | ((buf[at + 1] as number) << 8)) >>> (pos & 7)
					copy += word & ((1 << extra) - 1)
					pos += extra
				}

				at = pos >>> 3
				word = ((buf[at] as number) | ((buf[at + 1] as number) << 8) | ((buf[at + 2] as number) << 16)) >>> (pos & 7)

				const distanceEntry = distanceTable[word & distanceMask] as number
				const distanceLength = distanceEntry & 15

				if (distanceLength === 0) throw corrupt("an unknown distance code")

				pos += distanceLength

				const code = distanceEntry >>> 4

				if (code > 29) throw corrupt("an invalid distance code")

				let distance = DISTANCE_BASE[code] as number
				const distanceExtra = DISTANCE_EXTRA[code] as number

				if (distanceExtra > 0) {
					at = pos >>> 3
					word = ((buf[at] as number) | ((buf[at + 1] as number) << 8) | ((buf[at + 2] as number) << 16)) >>> (pos & 7)
					distance += word & ((1 << distanceExtra) - 1)
					pos += distanceExtra
				}

				if (distance > o) throw corrupt("a distance before the stream's start")

				let from = o - distance

				if (distance >= copy) {
					out.copyWithin(o, from, from + copy)
					o += copy
				} else {
					const stop = o + copy

					while (o < stop) out[o++] = out[from++] as number
				}
			}

			if (pos > this.valid * 8) throw corrupt("the stream ends early")

			this.produced += o - outStart
			this.o = o
			this.pos = pos

			if (blockEnd) this.mode = this.final ? Mode.Done : Mode.Header
			else if (pos >= limit && o < stopAt) {
				if (end) throw corrupt("the stream ends early")

				return Stop.Input
			}
		}
	}
}

// Runs `inflater` up to `target` bytes of output (or the end), handing each run of new output to `take` (a view
// valid only during the call), reading input as needed, and calling `mark` whenever produced reaches `every`'s next
// multiple (for the index build).
async function run(
	inflater: Inflater,
	target: number,
	take: (bytes: Uint8Array, at: number) => void,
	options: {
		readonly every?: number
		readonly mark?: (checkpoint: InflateCheckpoint) => void
		readonly clock?: ReturnType<typeof sliceClock>
		readonly signal?: { readonly aborted: boolean }
	} = {}
): Promise<void> {
	const every = options.every ?? 0
	let nextMark = every > 0 ? (Math.floor(inflater.produced / every) + 1) * every : Infinity
	// Marks by input as well, so a run of input that inflates to little (empty blocks) is never decoded again by a read.
	let nextInputMark = every > 0 ? inflater.bit + every * 8 : Infinity
	const hand = (): void => {
		if (inflater.o > inflater.pending) {
			take(inflater.out.subarray(inflater.pending, inflater.o), inflater.produced - (inflater.o - inflater.pending))
			inflater.pending = inflater.o
		}
	}

	for (;;) {
		const stop = inflater.decode(Math.min(target, nextMark), nextInputMark)

		if (stop === Stop.End) {
			hand()

			return
		}

		if (stop === Stop.Full) {
			hand()
			inflater.slide()
		} else if (stop === Stop.Target) {
			if (inflater.produced >= target) {
				hand()

				return
			}

			// A mark: the checkpoint's window is the output's tail, whatever was handed over.
			options.mark?.(inflater.checkpoint())
			nextMark = (Math.floor(inflater.produced / every) + 1) * every
			nextInputMark = inflater.bit + every * 8
		} else if (stop === Stop.Input) await inflater.fill()

		if (options.signal?.aborted === true) throw new ZipError("corrupt", "aborted")
		if (options.clock?.due === true) {
			hand()
			await options.clock.pause()
		}
	}
}

export interface InflateIndexBuild {
	// The entry's uncompressed size and CRC-32 (the central directory's), checked when the build ends.
	readonly size: number
	readonly crc32: number
	// Output bytes between checkpoints (default INFLATE_CHECKPOINT_BYTES).
	readonly every?: number
	readonly slicing?: Slicing
	readonly signal?: { readonly aborted: boolean }
	// Bytes of output decoded so far.
	readonly progress?: (produced: number) => void
}

export interface InflateReadStats {
	// Output bytes decoded to serve the read (from its checkpoint to its end).
	work: number
}

// Live decoders kept positioned after a read, so the next read just past it continues instead of starting again.
const CURSORS = 2

// The checkpoints of one deflated entry and the reads they serve. Holds about 32 KiB per checkpoint (16 MiB for
// 1 GiB of output at the default spacing) plus up to CURSORS live decoders (under 1 MiB each).
export class InflateIndex {
	readonly size: number
	readonly checkpoints: readonly InflateCheckpoint[]
	private readonly input: InflateInput
	private readonly cursors: Inflater[] = []

	private constructor(input: InflateInput, size: number, checkpoints: readonly InflateCheckpoint[]) {
		this.input = input
		this.size = size
		this.checkpoints = checkpoints
	}

	// Inflates the whole entry once, checking its size and CRC-32, and records a checkpoint every `every` bytes of
	// output and of input. An entry whose compressed bytes pass deflateBound is refused before any is read.
	static async build(input: InflateInput, options: InflateIndexBuild): Promise<InflateIndex> {
		if (input.size > deflateBound(options.size))
			throw new ZipError("corrupt", "The entry's compressed size passes what its declared size can need")

		const inflater = new Inflater(input)
		const checkpoints: InflateCheckpoint[] = [inflater.checkpoint()]
		const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
		let crc = 0
		let reported = 0

		await run(
			inflater,
			Infinity,
			bytes => {
				crc = crc32(bytes, crc)

				if (inflater.produced > options.size) throw new ZipError("corrupt", "The entry inflates past its declared size")
				if (options.progress !== undefined && inflater.produced - reported >= PROGRESS_BYTES) {
					reported = inflater.produced
					options.progress(reported)
				}
			},
			{
				every: options.every ?? INFLATE_CHECKPOINT_BYTES,
				mark: checkpoint => checkpoints.push(checkpoint),
				...(clock === undefined ? {} : { clock }),
				...(options.signal === undefined ? {} : { signal: options.signal })
			}
		)

		if (inflater.produced !== options.size) throw new ZipError("corrupt", "The entry is shorter than its declared size")
		if (crc !== options.crc32) throw new ZipError("corrupt", "CRC mismatch")

		options.progress?.(inflater.produced)

		return new InflateIndex(input, options.size, checkpoints)
	}

	// Bytes the checkpoints' windows hold.
	get windowBytes(): number {
		let total = 0

		for (const checkpoint of this.checkpoints) total += checkpoint.window.length + (checkpoint.lengths?.length ?? 0)

		return total
	}

	// The output [offset, offset + length), inflated from the nearest checkpoint at or before `offset` (or from a live
	// decoder a previous read left between that checkpoint and `offset`). An aborted `signal` stops it (ZipError).
	async read(offset: number, length: number, stats?: InflateReadStats, signal?: { readonly aborted: boolean }): Promise<Uint8Array> {
		if (offset < 0 || length < 0 || offset + length > this.size) throw new RangeError("Read outside the entry")

		const result = new Uint8Array(length)

		if (length === 0) return result

		const inflater = this.cursor(offset)
		const start = inflater.produced
		const end = offset + length

		// What the decoder already passed is still in its output buffer (a cursor stops a little past a read's end).
		if (start > offset) {
			const to = Math.min(end, start)

			result.set(inflater.out.subarray(inflater.o - (start - offset), inflater.o - (start - to)), 0)
		}

		try {
			await run(
				inflater,
				end,
				(bytes, at) => {
					const from = Math.max(offset, at)
					const to = Math.min(end, at + bytes.length)

					if (to > from) result.set(bytes.subarray(from - at, to - at), from - offset)
				},
				signal === undefined ? {} : { signal }
			)
		} catch (error) {
			throw error instanceof ZipError ? error : corrupt(error instanceof Error ? error.message : String(error))
		}

		if (inflater.produced < end) throw corrupt("the stream ends early")
		if (stats !== undefined) stats.work = inflater.produced - start

		if (!inflater.done) {
			this.cursors.push(inflater)

			if (this.cursors.length > CURSORS) this.cursors.shift()
		}

		return result
	}

	// A decoder that can serve `offset`: a live one past the checkpoint before it whose output buffer still holds
	// `offset` or that has not reached it yet (taken out of the pool while it reads), else a new one at the checkpoint.
	private cursor(offset: number): Inflater {
		const checkpoint = this.checkpointAt(offset)
		let best = -1

		for (let k = 0; k < this.cursors.length; k++) {
			const cursor = this.cursors[k] as Inflater
			const produced = cursor.produced

			if (
				produced - cursor.o <= offset &&
				produced > checkpoint.out &&
				(best < 0 || produced > (this.cursors[best] as Inflater).produced)
			)
				best = k
		}

		if (best >= 0) return this.cursors.splice(best, 1)[0] as Inflater

		return new Inflater(this.input, checkpoint)
	}

	private checkpointAt(offset: number): InflateCheckpoint {
		let low = 0
		let high = this.checkpoints.length - 1

		while (low < high) {
			const middle = (low + high + 1) >>> 1

			if ((this.checkpoints[middle] as InflateCheckpoint).out <= offset) low = middle
			else high = middle - 1
		}

		return this.checkpoints[low] as InflateCheckpoint
	}
}
