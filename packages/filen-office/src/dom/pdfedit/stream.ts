import { CTRL, RESP, SYNC_RANGE_CLOSE, SYNC_RANGE_MAX_RUN, SYNC_RANGE_WAKE, SyncRangeLayout } from "./syncRange"

// The reading end of a sync range buffer (syncRange.ts), for MuPDF's synchronous stream: every read copies from the
// slot ring straight into the destination (MuPDF's heap), one copy per byte. A miss posts the blocks it needs and
// waits for them, checking the abort word and an overall deadline; a read that cannot complete returns -1, which
// MuPDF raises as a "try later" error of the operation that read: the document stays usable for the next one.

export interface SyncRangeWakePort {
	postMessage(message: unknown): void
}

export type SyncReadFailure = "aborted" | "timeout" | "failed" | "closed"

export interface SyncRangeReaderOptions {
	// How long one read may wait for its bytes in all (the range ports' stall timeout).
	readonly deadlineMs: number
	readonly now: () => number
	// Longest single wait between checks of the deadline.
	readonly sliceMs?: number
}

export class SyncRangeReader {
	readonly length: number
	// Why the last failed read failed; null after a read that succeeded.
	failure: SyncReadFailure | null = null
	// Bytes copied out, and blocks requested from the server.
	bytesCopied = 0
	blocksRequested = 0
	private readonly layout: SyncRangeLayout
	private readonly port: SyncRangeWakePort
	private readonly options: SyncRangeReaderOptions
	private hint = -1
	private closed = false

	constructor(buffer: SharedArrayBuffer, port: SyncRangeWakePort, length: number, options: SyncRangeReaderOptions) {
		this.layout = new SyncRangeLayout(buffer)
		this.port = port
		this.length = length
		this.options = options
	}

	// MuPDF's read: up to `length` bytes at `position` into `target` at `offset`; the count, 0 at the end, -1 on
	// failure.
	read(target: Uint8Array, offset: number, length: number, position: number): number {
		if (this.closed) return this.fail("closed")
		if (position >= this.length || length <= 0) return 0

		const end = Math.min(this.length, position + length)
		const { blockBytes } = this.layout
		const deadline = this.options.now() + this.options.deadlineMs
		let at = position

		while (at < end) {
			const block = Math.floor(at / blockBytes)
			const copied = this.copy(block, target, offset + (at - position), at, end)

			if (copied > 0) {
				at += copied

				continue
			}

			const lastBlock = Math.floor((end - 1) / blockBytes)
			const reason = this.request(block, Math.min(SYNC_RANGE_MAX_RUN, lastBlock - block + 1), deadline)

			if (reason !== null) return this.fail(reason)
		}

		this.failure = null
		this.bytesCopied += end - position

		return end - position
	}

	// Copies what `block` holds of [at, end) when a slot holds it: the bytes copied, 0 on a miss.
	private copy(block: number, target: Uint8Array, targetOffset: number, at: number, end: number): number {
		const { layout } = this
		const slot = layout.find(block, this.hint)

		if (slot === -1) return 0

		const generation = layout.generationOf(slot)

		if ((generation & 1) === 1) return 0

		const blockStart = block * layout.blockBytes
		const from = slot * layout.blockBytes + (at - blockStart)
		const count = Math.min(end, blockStart + layout.blockBytes) - at

		target.set(layout.data.subarray(from, from + count), targetOffset)

		// Reused under the copy: read it again.
		if (layout.generationOf(slot) !== generation || layout.blockOf(slot) !== block) return 0

		this.hint = slot
		layout.touch(slot)

		return count
	}

	// Asks for `count` blocks from `first` and waits for the answer: null once answered ok, else why not.
	private request(first: number, count: number, deadline: number): SyncReadFailure | null {
		const { ctrl } = this.layout

		if (Atomics.load(ctrl, CTRL.abort) === 1) return "aborted"

		Atomics.store(ctrl, CTRL.reqBlock, first)
		Atomics.store(ctrl, CTRL.reqCount, count)

		const seq = Atomics.add(ctrl, CTRL.reqSeq, 1) + 1

		this.blocksRequested += count
		this.port.postMessage({ [SYNC_RANGE_WAKE]: seq })
		Atomics.store(ctrl, CTRL.waiting, 1)

		const reason = this.await(seq, deadline)

		Atomics.store(ctrl, CTRL.waiting, 0)

		return reason
	}

	private await(seq: number, deadline: number): SyncReadFailure | null {
		const { ctrl } = this.layout
		const slice = this.options.sliceMs ?? 1000

		for (;;) {
			if (Atomics.load(ctrl, CTRL.abort) === 1) return "aborted"

			const answered = Atomics.load(ctrl, CTRL.respSeq)

			if (answered === seq) {
				const status = Atomics.load(ctrl, CTRL.respStatus)

				return status === RESP.ok ? null : status === RESP.closed ? "closed" : "failed"
			}

			const left = deadline - this.options.now()

			if (left <= 0) return "timeout"

			Atomics.wait(ctrl, CTRL.respSeq, answered, Math.min(left, slice))
		}
	}

	private fail(reason: SyncReadFailure): number {
		this.failure = reason

		if (reason === "aborted" || reason === "closed") this.closed = true

		return -1
	}

	// Tells the server the reader is done.
	close(): void {
		if (this.closed) return

		this.closed = true
		this.port.postMessage({ [SYNC_RANGE_CLOSE]: true })
	}
}

// MuPDF's stream handle over a reader (new mupdf.Stream(handle)).
export interface MupdfStreamHandle {
	fileSize(): number
	read(memory: Uint8Array, offset: number, length: number, position: number): number
	close(): void
}

export function syncRangeStreamHandle(reader: SyncRangeReader): MupdfStreamHandle {
	return {
		fileSize: () => reader.length,
		read: (memory, offset, length, position) => reader.read(memory, offset, length, position),
		// MuPDF drops its stream with the document; the reader's owner closes the reader.
		close: () => undefined
	}
}
