import { BLOCK_BYTES } from "@filen/shared/videos"

// A range read that can be called off. `end` is exclusive.
export type AbortableReadRange = (start: number, end: number, signal: AbortSignal) => Promise<Uint8Array>

// Resident blocks. A demuxer walking a file sequentially needs the block it is in plus the read-ahead;
// the rest is headroom for a header block revisited between clusters.
const DEFAULT_CAPACITY = 12

// Blocks fetched past the reader once it has moved forward block by block twice in a row.
const DEFAULT_READ_AHEAD = 3

// Consecutive forward block steps before read-ahead starts.
const SEQUENTIAL_STEPS_FOR_READ_AHEAD = 2

// Blocks per range request. The SDK downloads the chunks of one request in parallel, so a run of a few
// blocks is faster than block-sized requests, while a cap keeps one cluster-sized read from holding
// tens of megabytes in a single response.
export const MAX_RUN_BLOCKS = 4

// Below any block index by more than one, so a first read never counts as a forward step.
const NO_BLOCK = -2

// Thrown to readers whose block download was called off by abort().
export class BlockAbortError extends Error {
	public constructor() {
		super("block read aborted")
		this.name = "BlockAbortError"
	}
}

export interface BlockCacheOptions {
	capacity?: number
	readAhead?: number
	// Sees every block as it lands (a subtitle tap scanning what playback already read). Never reads.
	onBlock?: (index: number, bytes: Uint8Array) => void
}

export interface BlockCacheStats {
	// Blocks downloaded (read-ahead included).
	blockReads: number
	// Bytes those downloads returned.
	bytesRead: number
	// Range requests issued; a run of blocks is one.
	rangeReads: number
	// Blocks requested by read-ahead before anyone asked for them.
	readAheadBlocks: number
}

// Random access over a remote file in aligned blocks, shared by everything that reads one file while it
// plays: the demuxer, a probe, a subtitle tap. Least-recently-used eviction, one download per block no
// matter how many readers want it at once, read-ahead for sequential readers, and abort() to call off
// every download in flight (a seek) without dropping what has already landed.
export class BlockCache {
	public readonly size: number
	public readonly stats: BlockCacheStats = { blockReads: 0, bytesRead: 0, rangeReads: 0, readAheadBlocks: 0 }
	private readonly readRange: AbortableReadRange
	private readonly capacity: number
	private readonly readAhead: number
	private readonly onBlock: ((index: number, bytes: Uint8Array) => void) | undefined
	// Map order is the LRU order, oldest first.
	private readonly resident = new Map<number, Uint8Array>()
	private readonly inFlight = new Map<number, Promise<Uint8Array>>()
	private controller = new AbortController()
	// The furthest block the current forward pattern has reached; NO_BLOCK when there is none.
	private lastBlock = NO_BLOCK
	private sequentialSteps = 0
	private disposed = false

	public constructor(size: number, readRange: AbortableReadRange, options: BlockCacheOptions = {}) {
		this.size = size
		this.readRange = readRange
		this.capacity = Math.max(2, options.capacity ?? DEFAULT_CAPACITY)
		this.readAhead = Math.max(0, options.readAhead ?? DEFAULT_READ_AHEAD)
		this.onBlock = options.onBlock
	}

	public get blockCount(): number {
		return Math.ceil(this.size / BLOCK_BYTES)
	}

	// Every resident block, in file order (a tap set up after the first reads catches up with them).
	public forEachResident(visit: (index: number, bytes: Uint8Array) => void): void {
		for (const index of [...this.resident.keys()].sort((x, y) => x - y)) {
			const bytes = this.resident.get(index)

			if (bytes !== undefined) {
				visit(index, bytes)
			}
		}
	}

	public isResident(position: number): boolean {
		return this.resident.has(Math.floor(position / BLOCK_BYTES))
	}

	// Bytes [start, end). Synchronous when every block is resident, so a parser stepping through a block
	// it already holds never waits a microtask; a range inside one block is a view, not a copy.
	public read(start: number, end: number): Uint8Array | Promise<Uint8Array> {
		const [first, last] = this.span(start, end)

		this.noteAccess(first, last)

		if (first !== last) {
			return this.assemble(start, end, first, last)
		}

		const offset = first * BLOCK_BYTES
		const resident = this.touch(first)

		if (resident !== undefined) {
			return resident.subarray(start - offset, end - offset)
		}

		return this.block(first).then(bytes => bytes.subarray(start - offset, end - offset))
	}

	// The same bytes as a stream of block views, for reads too large to want assembled in one buffer (a
	// demuxer loading a whole cluster): each block is handed on as it lands and can be evicted after.
	public stream(start: number, end: number): ReadableStream<Uint8Array> {
		const [first, last] = this.span(start, end)

		this.noteAccess(first, last)

		const blocks = this.blocksOf(first, last)

		return new ReadableStream<Uint8Array>({
			pull: async controller => {
				const next = await blocks.next()

				if (next.done === true) {
					controller.close()

					return
				}

				const { index, bytes } = next.value
				const offset = index * BLOCK_BYTES
				const from = Math.max(start, offset) - offset
				const to = Math.min(end, offset + bytes.length) - offset

				controller.enqueue(bytes.subarray(from, to))
			},
			cancel: async () => {
				await blocks.return(undefined)
			}
		})
	}

	// Calls off every download in flight; readers waiting on them reject with BlockAbortError. Resident
	// blocks stay, and the read-ahead pattern starts over.
	public abort(): void {
		this.controller.abort()
		this.controller = new AbortController()
		this.inFlight.clear()
		this.lastBlock = NO_BLOCK
		this.sequentialSteps = 0
	}

	// Aborts and drops everything; the cache refuses reads afterwards.
	public dispose(): void {
		this.abort()
		this.resident.clear()
		this.disposed = true
	}

	private span(start: number, end: number): [number, number] {
		if (this.disposed) {
			throw new BlockAbortError()
		}

		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.size) {
			throw new RangeError(`read [${String(start)}, ${String(end)}) is outside a ${String(this.size)}-byte file`)
		}

		return [Math.floor(start / BLOCK_BYTES), Math.floor((end - 1) / BLOCK_BYTES)]
	}

	private touch(index: number): Uint8Array | undefined {
		const bytes = this.resident.get(index)

		if (bytes !== undefined) {
			this.resident.delete(index)
			this.resident.set(index, bytes)
		}

		return bytes
	}

	private async assemble(start: number, end: number, first: number, last: number): Promise<Uint8Array> {
		const out = new Uint8Array(end - start)

		for await (const { index, bytes } of this.blocksOf(first, last)) {
			const offset = index * BLOCK_BYTES
			const from = Math.max(start, offset)
			const to = Math.min(end, offset + bytes.length)

			out.set(bytes.subarray(from - offset, to - offset), from - start)
		}

		return out
	}

	// Blocks first..last in order, keeping one run's download ahead of the consumer. Each block is held
	// from the moment it is requested, so one evicted before the consumer gets to it is not fetched twice.
	private async *blocksOf(first: number, last: number): AsyncGenerator<{ index: number; bytes: Uint8Array }, void, undefined> {
		const held = new Map<number, Uint8Array | Promise<Uint8Array>>()
		let requestedTo = first - 1

		for (let index = first; index <= last; index++) {
			if (requestedTo < last && index + MAX_RUN_BLOCKS > requestedTo) {
				const to = Math.min(last, requestedTo + MAX_RUN_BLOCKS)

				this.ensure(requestedTo + 1, to, held)
				requestedTo = to
			}

			const bytes = held.get(index) ?? this.block(index)

			held.delete(index)
			this.touch(index)

			yield { index, bytes: await bytes }
		}
	}

	private block(index: number): Promise<Uint8Array> {
		const flying = this.inFlight.get(index)

		if (flying !== undefined) {
			return flying
		}

		const [block] = this.fetchRun(index, index)

		if (block === undefined) {
			throw new RangeError("empty block run")
		}

		return block
	}

	// Starts downloads for the blocks in first..last that are neither resident nor in flight, as runs of
	// contiguous missing blocks. Every block of the range, resident or on its way, goes into `into`.
	private ensure(first: number, last: number, into?: Map<number, Uint8Array | Promise<Uint8Array>>): void {
		let runStart = -1

		for (let index = first; index <= last + 1; index++) {
			const present = index <= last ? (this.resident.get(index) ?? this.inFlight.get(index)) : undefined
			const missing = index <= last && present === undefined

			if (present !== undefined) {
				into?.set(index, present)
			}

			if (missing && runStart === -1) {
				runStart = index
			}

			if (runStart !== -1 && (!missing || index - runStart === MAX_RUN_BLOCKS)) {
				const blocks = this.fetchRun(runStart, index - 1)

				for (const [offset, block] of blocks.entries()) {
					// Read-ahead nobody waits on: its failure is not an error anyone sees.
					block.catch(() => undefined)
					into?.set(runStart + offset, block)
				}

				runStart = missing ? index : -1
			}
		}
	}

	// One range request for blocks first..last; a promise per block.
	private fetchRun(first: number, last: number): Promise<Uint8Array>[] {
		const start = first * BLOCK_BYTES
		const end = Math.min(this.size, (last + 1) * BLOCK_BYTES)
		const { signal } = this.controller

		this.stats.rangeReads++

		const run = this.readRange(start, end, signal).then(
			bytes => {
				if (signal.aborted) {
					throw new BlockAbortError()
				}

				if (bytes.length !== end - start) {
					throw new Error(`short range read: ${String(bytes.length)} of ${String(end - start)} bytes`)
				}

				this.stats.blockReads += last - first + 1
				this.stats.bytesRead += bytes.length

				return bytes
			},
			(error: unknown) => {
				throw signal.aborted ? new BlockAbortError() : error
			}
		)
		const blocks: Promise<Uint8Array>[] = []

		for (let index = first; index <= last; index++) {
			const offset = (index - first) * BLOCK_BYTES
			// A run of one keeps the response as is; a longer run is cut into copies so each block can be
			// evicted on its own instead of pinning the whole response while any of its blocks is resident.
			const block = run.then(bytes => {
				const piece = last === first ? bytes : bytes.slice(offset, offset + BLOCK_BYTES)

				if (this.inFlight.get(index) === block) {
					this.inFlight.delete(index)
					this.store(index, piece)
				}

				return piece
			})

			block.catch(() => {
				if (this.inFlight.get(index) === block) {
					this.inFlight.delete(index)
				}
			})

			this.inFlight.set(index, block)
			blocks.push(block)
		}

		return blocks
	}

	private store(index: number, bytes: Uint8Array): void {
		const fresh = !this.resident.has(index)

		this.resident.delete(index)
		this.resident.set(index, bytes)

		if (fresh) {
			this.onBlock?.(index, bytes)
		}

		while (this.resident.size > this.capacity) {
			const oldest = this.resident.keys().next()

			if (oldest.done === true) {
				break
			}

			this.resident.delete(oldest.value)
		}
	}

	private noteAccess(first: number, last: number): void {
		if (last > this.lastBlock && first <= this.lastBlock + 1 && this.lastBlock !== NO_BLOCK) {
			// Reached past the furthest block, starting next to or inside it.
			this.sequentialSteps++
			this.lastBlock = last
		} else if (last > this.lastBlock || first < this.lastBlock - 1) {
			// A jump, either way.
			this.sequentialSteps = 0
			this.lastBlock = last
		}

		if (this.sequentialSteps < SEQUENTIAL_STEPS_FOR_READ_AHEAD || this.readAhead === 0) {
			return
		}

		const from = last + 1
		const to = Math.min(this.blockCount - 1, last + this.readAhead)
		const { signal } = this.controller

		// After the read that triggered it has made its own request, which must not queue behind this one;
		// dropped if a seek aborted in between.
		setTimeout(() => {
			if (signal.aborted || this.disposed) {
				return
			}

			for (let index = from; index <= to; index++) {
				if (!this.resident.has(index) && !this.inFlight.has(index)) {
					this.stats.readAheadBlocks++
				}
			}

			this.ensure(from, to)
		}, 0)
	}
}
