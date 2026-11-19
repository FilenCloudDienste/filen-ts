// Content too large to hold joined in one array (a rewritten part of a long document): its pieces in order,
// read as often as needed. A writer streams it (zipWriter), never joining it.
export interface ByteChunks {
	readonly length: number
	chunks(): AsyncIterable<Uint8Array>
}

// What a part's new content is: joined bytes, or pieces.
export type PartBytes = Uint8Array | ByteChunks

// Pieces handed to a reader at most this long; shorter ones are gathered (copied) into chunks of about
// GATHER, so a reader sees few, large chunks however finely the content is cut.
const CHUNK = 4 * 1024 * 1024
const GATHER = 1024 * 1024
// Pieces taken between looks at `due` while building.
const BUILD_STEP = 16_384

interface Layout {
	readonly pieces: readonly Uint8Array[]
	// Start of each piece.
	readonly offsets: Float64Array
	readonly length: number
}

// Views that continue one another (consecutive copies of a source) become one piece; yields when `due`.
function* layout(pieces: readonly Uint8Array[], due: () => boolean): Generator<void, Layout> {
	const joined: Uint8Array[] = []
	// The run of views being joined: its first piece, and where it starts and ends in that buffer.
	let first: Uint8Array | undefined
	let start = 0
	let end = 0
	let count = 0
	const close = (): void => {
		if (first !== undefined) joined.push(count === 1 ? first : new Uint8Array(first.buffer, start, end - start))
	}

	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index] as Uint8Array

		if (index % BUILD_STEP === BUILD_STEP - 1 && due()) yield

		if (piece.length === 0) continue

		if (first !== undefined && piece.byteOffset === end && piece.buffer === first.buffer) {
			end += piece.length
			count++

			continue
		}

		close()
		first = piece
		start = piece.byteOffset
		end = start + piece.length
		count = 1
	}

	close()

	if (due()) yield

	const offsets = new Float64Array(joined.length)
	let at = 0

	for (let index = 0; index < joined.length; index++) {
		offsets[index] = at
		at += (joined[index] as Uint8Array).length
	}

	return { pieces: joined, offsets, length: at }
}

// Bytes as a sequence of views (of a source part, of new markup), with random access, never joined: the
// part a save assembles is mostly views of the part it replaces, so it costs only what is new. A window
// (window()) is a range of another one, sharing its pieces.
export class BytePieces implements ByteChunks {
	readonly length: number
	private readonly laid: Layout
	// Where this window starts in the layout.
	private readonly base: number

	private constructor(laid: Layout, base: number, length: number) {
		this.laid = laid
		this.base = base
		this.length = length
	}

	static of(pieces: readonly Uint8Array[]): BytePieces {
		const steps = layout(pieces, () => false)

		for (;;) {
			const step = steps.next()

			if (step.done === true) return new BytePieces(step.value, 0, step.value.length)
		}
	}

	// BytePieces.of in steps: `pause` runs whenever `due` says so.
	static async build(pieces: readonly Uint8Array[], due: () => boolean, pause: () => Promise<void>): Promise<BytePieces> {
		const steps = layout(pieces, due)

		for (;;) {
			const step = steps.next()

			if (step.done === true) return new BytePieces(step.value, 0, step.value.length)

			await pause()
		}
	}

	// Bytes [from, from + length) of these, sharing their pieces.
	window(from: number, length: number): BytePieces {
		return new BytePieces(this.laid, this.base + from, Math.max(0, Math.min(length, this.length - from)))
	}

	// The piece holding layout byte `offset` (the last piece at or before it).
	private pieceAt(offset: number): number {
		const offsets = this.laid.offsets
		let low = 0
		let high = this.laid.pieces.length - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((offsets[middle] ?? 0) <= offset) low = middle
			else high = middle - 1
		}

		return low
	}

	// Calls `visit` for each piece's share of [from, from + length): the piece, where in it, how much, and
	// where that share starts in the range. Stops (returning false) when a visit returns false, or when the
	// range runs past the end.
	visit(from: number, length: number, visit: (piece: Uint8Array, pieceFrom: number, count: number, at: number) => boolean): boolean {
		if (from < 0 || from + length > this.length) return false

		const { pieces, offsets } = this.laid
		const start = this.base + from
		let done = 0

		for (let index = length > 0 ? this.pieceAt(start) : pieces.length; done < length && index < pieces.length; index++) {
			const piece = pieces[index] as Uint8Array
			const pieceFrom = start + done - (offsets[index] ?? 0)
			const count = Math.min(piece.length - pieceFrom, length - done)

			if (!visit(piece, pieceFrom, count, done)) return false

			done += count
		}

		return done === length
	}

	// Bytes [from, to): a view when they lie in one piece, else a copy.
	subarray(from: number, to: number = this.length): Uint8Array {
		const length = Math.max(0, Math.min(to, this.length) - from)
		let view: Uint8Array | undefined

		this.visit(from, length, (piece, pieceFrom, count) => {
			if (count === length) view = piece.subarray(pieceFrom, pieceFrom + count)

			return false
		})

		return view ?? this.copy(from, length)
	}

	// Bytes [from, from + length) in a buffer of their own.
	copy(from: number, length: number): Uint8Array<ArrayBuffer> {
		const out = new Uint8Array(Math.max(0, Math.min(length, this.length - from)))

		this.visit(from, out.length, (piece, pieceFrom, count, at) => {
			out.set(piece.subarray(pieceFrom, pieceFrom + count), at)

			return true
		})

		return out
	}

	async *chunks(): AsyncIterable<Uint8Array> {
		let gathered: Uint8Array | null = null
		let filled = 0
		const shares: Uint8Array[] = []

		this.visit(0, this.length, (piece, pieceFrom, count) => {
			shares.push(piece.subarray(pieceFrom, pieceFrom + count))

			return true
		})

		for (const share of shares) {
			if (gathered !== null && (share.length >= GATHER || filled + share.length > gathered.length)) {
				yield gathered.subarray(0, filled)
				gathered = null
			}

			if (share.length < GATHER) {
				if (gathered === null) {
					gathered = new Uint8Array(GATHER)
					filled = 0
				}

				gathered.set(share, filled)
				filled += share.length

				continue
			}

			for (let from = 0; from < share.length; from += CHUNK) yield share.subarray(from, Math.min(share.length, from + CHUNK))
		}

		if (gathered !== null) yield gathered.subarray(0, filled)
	}
}

export function isByteChunks(bytes: PartBytes): bytes is ByteChunks {
	return !(bytes instanceof Uint8Array)
}

// The content joined (pieces are copied once).
export async function joinBytes(bytes: PartBytes): Promise<Uint8Array> {
	if (bytes instanceof Uint8Array) return bytes
	if (bytes instanceof BytePieces) return bytes.copy(0, bytes.length)

	const out = new Uint8Array(bytes.length)
	let at = 0

	for await (const chunk of bytes.chunks()) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}
