// A file's bytes for a synchronous reader in one worker (MuPDF's stream reads, inside wasm), served by an
// asynchronous source in another (the SDK worker's range reads, or a buffer held elsewhere). Both sides share one
// SharedArrayBuffer: control words and a ring of block slots, which is the only block cache. The reader copies from a
// slot straight to its destination; on a miss it posts the run of blocks it needs on a port and waits on the control
// words until the server has written them (Atomics.wait in the reader, Atomics.notify in the server). The server
// pipelines read-ahead of the blocks after a sequential run while the reader computes.
//
// Slots are guarded by a sequence lock: a writer makes the slot's generation odd, writes, sets the block and makes
// it even again; a reader copies only from an even generation that is unchanged after the copy, so a slot reused
// under a copy is read again instead of handing out torn bytes.

// The control words, as indices into the Int32Array over the buffer's start.
export const CTRL = {
	// Incremented by the reader for each request (after REQ_BLOCK and REQ_COUNT are set).
	reqSeq: 0,
	reqBlock: 1,
	reqCount: 2,
	// Set by the server to the request it answered, after RESP_STATUS.
	respSeq: 3,
	respStatus: 4,
	// Set by the reader's owner to stop every read; the reader fails at once.
	abort: 5,
	// 1 while the reader waits for bytes (a watchdog of the reader's work excludes that time).
	waiting: 6,
	slots: 7,
	blockBytes: 8,
	// The LRU clock: both sides stamp a slot with the next tick when they use it.
	tick: 9
} as const

export const RESP = { ok: 0, failed: 1, closed: 2 } as const

const HEADER_WORDS = 10
const SLOT_WORDS = 3
// A slot's words: the block it holds (-1: none), its generation, its last use.
const SLOT_BLOCK = 0
const SLOT_GEN = 1
const SLOT_TICK = 2

export const SYNC_RANGE_DEFAULT_SLOTS = 32
// Most blocks one request asks for: one aligned range read of the source.
export const SYNC_RANGE_MAX_RUN = 4

function controlWords(slots: number): number {
	return HEADER_WORDS + slots * SLOT_WORDS
}

function dataOffset(slots: number): number {
	return Math.ceil((controlWords(slots) * 4) / 8) * 8
}

// A buffer for `slots` blocks of `blockBytes` (the source's own block size, so every byte downloads once).
export function createSyncRangeBuffer(slots: number, blockBytes: number): SharedArrayBuffer {
	if (!Number.isInteger(slots) || slots < 4 || !Number.isInteger(blockBytes) || blockBytes < 1024) {
		throw new RangeError("invalid sync range layout")
	}

	const buffer = new SharedArrayBuffer(dataOffset(slots) + slots * blockBytes)
	const ctrl = new Int32Array(buffer, 0, controlWords(slots))

	ctrl[CTRL.slots] = slots
	ctrl[CTRL.blockBytes] = blockBytes

	for (let slot = 0; slot < slots; slot++) ctrl[HEADER_WORDS + slot * SLOT_WORDS + SLOT_BLOCK] = -1

	return buffer
}

// Both sides' view of a buffer made by createSyncRangeBuffer.
export class SyncRangeLayout {
	readonly ctrl: Int32Array
	readonly data: Uint8Array
	readonly slots: number
	readonly blockBytes: number

	constructor(buffer: SharedArrayBuffer) {
		const head = new Int32Array(buffer, 0, HEADER_WORDS)
		const slots = Atomics.load(head, CTRL.slots)
		const blockBytes = Atomics.load(head, CTRL.blockBytes)

		if (slots < 4 || blockBytes < 1024 || buffer.byteLength !== dataOffset(slots) + slots * blockBytes) {
			throw new RangeError("invalid sync range buffer")
		}

		this.slots = slots
		this.blockBytes = blockBytes
		this.ctrl = new Int32Array(buffer, 0, controlWords(slots))
		this.data = new Uint8Array(buffer, dataOffset(slots), slots * blockBytes)
	}

	slotWord(slot: number, word: number): number {
		return HEADER_WORDS + slot * SLOT_WORDS + word
	}

	blockOf(slot: number): number {
		return Atomics.load(this.ctrl, this.slotWord(slot, SLOT_BLOCK))
	}

	generationOf(slot: number): number {
		return Atomics.load(this.ctrl, this.slotWord(slot, SLOT_GEN))
	}

	touch(slot: number): void {
		Atomics.store(this.ctrl, this.slotWord(slot, SLOT_TICK), Atomics.add(this.ctrl, CTRL.tick, 1) + 1)
	}

	tickOf(slot: number): number {
		return Atomics.load(this.ctrl, this.slotWord(slot, SLOT_TICK))
	}

	// The slot holding `block` with an even generation, or -1.
	find(block: number, hint: number): number {
		if (hint >= 0 && hint < this.slots && this.blockOf(hint) === block) return hint

		for (let slot = 0; slot < this.slots; slot++) if (this.blockOf(slot) === block) return slot

		return -1
	}
}

// Stops every read on `buffer` (the reader fails its current and later reads), before its worker is terminated: a
// reader blocked in Atomics.wait cannot take a message.
export function abortSyncRange(buffer: SharedArrayBuffer): void {
	const ctrl = new Int32Array(buffer, 0, HEADER_WORDS)

	Atomics.store(ctrl, CTRL.abort, 1)
	Atomics.notify(ctrl, CTRL.respSeq)
}

// Whether the reader is waiting for bytes right now.
export function syncRangeWaiting(buffer: SharedArrayBuffer): boolean {
	return Atomics.load(new Int32Array(buffer, 0, HEADER_WORDS), CTRL.waiting) === 1
}

// --- Server side ---

// The port a reader posts its requests on (a MessagePort, typed structurally).
export interface SyncRangePort {
	postMessage(message: unknown): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	start?(): void
	close(): void
}

export interface SyncRangeSource {
	readonly length: number
	// Exactly bytes [start, end); rejects when the read failed (the host aborts its reads with the lifetime).
	read(start: number, end: number): Promise<Uint8Array>
}

// An AbortSignal, typed structurally.
export interface SyncRangeLifetime {
	readonly aborted: boolean
	addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void
}

export interface SyncRangeServeOptions {
	// Ends the serving: pending and later requests are answered "closed" and the port closes.
	readonly lifetime: SyncRangeLifetime
	// Blocks read ahead after a sequential request (0 turns it off).
	readonly readAhead?: number
	// The reader closed: the host aborts `lifetime` (which stops the server) and frees what the source holds.
	readonly onReaderClose?: () => void
}

export interface SyncRangeServerStats {
	// Bytes read from the source (requests and read-ahead).
	readonly bytesRead: number
	readonly requests: number
}

// The reader's wake-up on the port: a request was written into the control words.
export const SYNC_RANGE_WAKE = "filen.syncRange.wake"
// The reader is done: the server stops.
export const SYNC_RANGE_CLOSE = "filen.syncRange.close"

function isMessage(data: unknown, key: string): boolean {
	return typeof data === "object" && data !== null && key in data
}

// Serves `source` into `buffer` for the reader posting on `port`, until `options.lifetime` aborts or the reader
// closes. Returns the server's statistics, live.
export function serveSyncRange(
	buffer: SharedArrayBuffer,
	port: SyncRangePort,
	source: SyncRangeSource,
	options: SyncRangeServeOptions
): SyncRangeServerStats {
	const layout = new SyncRangeLayout(buffer)
	const { ctrl, data, blockBytes } = layout
	const blockCount = Math.ceil(source.length / blockBytes)
	const readAhead = Math.max(0, Math.min(options.readAhead ?? 3, Math.floor(layout.slots / 4)))
	const lifetime = options.lifetime
	// Blocks being read (a request for one waits for it rather than reading it again), by block.
	const inflight = new Map<number, Promise<void>>()
	// Slots being written: never chosen for another block meanwhile.
	const writing = new Set<number>()
	const stats = { bytesRead: 0, requests: 0 }
	// The previous request's first block, and the last block it or its read-ahead covered: a request starting after
	// the one and at most just past the other continues a sequential read (none yet: the first is not one).
	let lastStart = Number.POSITIVE_INFINITY
	let lastEnd = -2
	let seen = 0
	// The request being served, until answered.
	let serving: number | null = null

	// Only the reader's latest request is answered: one it gave up on (its deadline passed) and replaced is not.
	const answer = (seq: number, status: number): void => {
		if (Atomics.load(ctrl, CTRL.reqSeq) !== seq) return

		serving = null
		Atomics.store(ctrl, CTRL.respStatus, status)
		Atomics.store(ctrl, CTRL.respSeq, seq)
		Atomics.notify(ctrl, CTRL.respSeq)
	}

	// The least recently used slot not holding `keep` and not being written: an empty one first.
	const victim = (keep: ReadonlySet<number>): number => {
		let best = -1
		let bestTick = Number.POSITIVE_INFINITY

		for (let slot = 0; slot < layout.slots; slot++) {
			if (writing.has(slot)) continue

			const block = layout.blockOf(slot)

			if (block === -1) return slot
			if (keep.has(block)) continue

			const tick = layout.tickOf(slot)

			if (tick < bestTick) {
				bestTick = tick
				best = slot
			}
		}

		return best
	}

	const write = (block: number, bytes: Uint8Array, keep: ReadonlySet<number>): void => {
		if (layout.find(block, -1) !== -1) return

		const slot = victim(keep)

		if (slot === -1) return

		const gen = layout.slotWord(slot, 1)
		const at = layout.slotWord(slot, 0)

		writing.add(slot)
		Atomics.store(ctrl, at, -1)
		Atomics.add(ctrl, gen, 1)
		data.set(bytes, slot * blockBytes)
		Atomics.store(ctrl, at, block)
		Atomics.add(ctrl, gen, 1)
		layout.touch(slot)
		writing.delete(slot)
	}

	// Reads blocks [first, first + count) in one aligned read and writes them into slots.
	const fetchRun = (first: number, count: number, keep: ReadonlySet<number>): Promise<void> => {
		const start = first * blockBytes
		const end = Math.min(source.length, (first + count) * blockBytes)
		const run = source.read(start, end).then(bytes => {
			if (bytes.length !== end - start) throw new Error("short range read")

			stats.bytesRead += bytes.length

			for (let index = 0; index < count; index++) {
				write(first + index, bytes.subarray(index * blockBytes, Math.min(bytes.length, (index + 1) * blockBytes)), keep)
			}
		})
		const settled = run.finally(() => {
			for (let index = 0; index < count; index++) if (inflight.get(first + index) === settled) inflight.delete(first + index)
		})

		for (let index = 0; index < count; index++) inflight.set(first + index, settled)

		return settled
	}

	// Every block of [first, last] is resident, read or being read; contiguous misses go out as one read.
	const ensure = (first: number, last: number, keep: ReadonlySet<number>): Promise<void>[] => {
		const waits: Promise<void>[] = []
		let runStart = -1

		const flush = (end: number): void => {
			if (runStart !== -1) {
				waits.push(fetchRun(runStart, end - runStart, keep))
				runStart = -1
			}
		}

		for (let block = first; block <= last; block++) {
			const pending = inflight.get(block)

			if (pending !== undefined) {
				flush(block)
				waits.push(pending)
			} else if (layout.find(block, -1) !== -1) {
				flush(block)
			} else {
				if (runStart === -1) runStart = block
				if (block - runStart + 1 >= SYNC_RANGE_MAX_RUN) flush(block + 1)
			}
		}

		flush(last + 1)

		return waits
	}

	const serve = async (seq: number, first: number, count: number): Promise<void> => {
		if (lifetime.aborted) {
			answer(seq, RESP.closed)

			return
		}

		const last = Math.min(blockCount - 1, first + Math.max(1, Math.min(count, SYNC_RANGE_MAX_RUN)) - 1)

		if (first < 0 || first > last) {
			answer(seq, RESP.failed)

			return
		}

		stats.requests++

		const keep = new Set<number>()

		for (let block = first; block <= last; block++) keep.add(block)

		const ok = await Promise.all(ensure(first, last, keep)).then(
			() => true,
			() => false
		)

		if (lifetime.aborted) {
			answer(seq, RESP.closed)

			return
		}

		answer(seq, ok ? RESP.ok : RESP.failed)

		const sequential = first > lastStart && first <= lastEnd + 1

		lastStart = first
		lastEnd = last

		// Pipelined after the answer: the reader computes on the blocks it has while the next ones download.
		if (ok && readAhead > 0 && sequential && last + 1 < blockCount) {
			lastEnd = Math.min(blockCount - 1, last + readAhead)

			for (const wait of ensure(last + 1, lastEnd, keep)) wait.catch(() => undefined)
		}
	}

	const stop = (): void => {
		answer(Atomics.load(ctrl, CTRL.reqSeq), RESP.closed)
		port.close()
	}

	if (lifetime.aborted) {
		stop()

		return stats
	}

	lifetime.addEventListener("abort", stop, { once: true })
	port.addEventListener("message", event => {
		if (isMessage(event.data, SYNC_RANGE_CLOSE)) {
			options.onReaderClose?.()

			return
		}

		if (!isMessage(event.data, SYNC_RANGE_WAKE)) return

		// The reader waits for each answer before asking again, so the request words hold its latest request. One
		// still being served when a newer one arrives was given up on; serving the newer one does not wait for it.
		const seq = Atomics.load(ctrl, CTRL.reqSeq)

		if (seq === seen) return

		seen = seq

		// The reads the abandoned request waits on may never settle: the new one reads its blocks again.
		if (serving !== null) inflight.clear()

		serving = seq
		void serve(seq, Atomics.load(ctrl, CTRL.reqBlock), Atomics.load(ctrl, CTRL.reqCount))
	})
	port.start?.()

	return stats
}
