import * as Comlink from "comlink"
import type { AbortableReadRange } from "@/lib/media/blockCache"

// Byte ranges of one file served over a MessagePort, so a reader in one worker (the remuxer) downloads
// straight from another (the SDK worker) without the page relaying every block. Each read carries an id
// the reader can cancel; the bytes come back transferred, never copied.
export interface RangePortApi {
	read(start: number, end: number, id: number): Promise<Uint8Array>
	// read() with the CRC-32 of the bytes continued from `crc`, computed here where the bytes live, so the reader can
	// check what arrived (a save copying them must not upload damaged bytes). Rejects when the port serves no checksum.
	readChecked(start: number, end: number, crc: number, id: number): Promise<{ bytes: Uint8Array; crc: number }>
	cancel(id: number): void
	// The reader is done with the file: in-flight reads are aborted and the port closed.
	close(): void
	// Takes the Web Lock `name` and holds it until the port shuts down; true once it is held, false when
	// it cannot be (already shut down, no Web Locks). A port whose serving worker dies posts nothing, but
	// the lock goes with the worker, so a reader waiting for it learns at once. The other way round,
	// `readerLock` is one the reader holds for as long as it reads: the port then lives exactly as long as
	// its reader (however long a player stays paused), and shuts down when the reader's worker dies.
	holdLife(name: string, readerLock?: string): Promise<boolean>
}

// Posted by the server as it shuts down (a cancel from its own side, the idle timeout), so the reader
// fails its reads at once instead of waiting on a port nobody answers any more.
const CLOSED_NOTICE = "filen.rangePort.closed"

// A served port nobody has read from for this long is shut down: a reader that went away without
// closing (a crashed worker) must not keep the file's entry alive for the rest of the session. Only for a
// reader that holds no lock of its own (holdLife's readerLock), whose death cannot be seen otherwise.
export const RANGE_PORT_IDLE_MS = 30 * 60_000

// Continues a CRC-32 over more bytes (the zip CRC: crc(b, crc(a)) === crc(a + b)).
export type RangeChecksum = (bytes: Uint8Array, crc: number) => number

// Serves `read` on `port` until `lifetime` aborts, which the reader's close() and the idle timeout do too. With
// `checksum`, readChecked is served too.
export function exposeRangePort(port: MessagePort, read: AbortableReadRange, lifetime: AbortController, checksum?: RangeChecksum): void {
	const closed = lifetime.signal
	const reads = new Map<number, AbortController>()
	let idle: ReturnType<typeof setTimeout> | undefined
	let readerWatched = false
	const armIdle = () => {
		clearTimeout(idle)

		if (reads.size === 0 && !readerWatched) {
			idle = setTimeout(() => {
				lifetime.abort()
			}, RANGE_PORT_IDLE_MS)
		}
	}
	const shutdown = () => {
		clearTimeout(idle)

		for (const controller of reads.values()) {
			controller.abort()
		}

		reads.clear()
		port.postMessage({ [CLOSED_NOTICE]: true })
		// A task later, so the rejections of the reads just aborted are posted before the port goes.
		setTimeout(() => {
			port.close()
		}, 0)
	}

	if (closed.aborted) {
		port.postMessage({ [CLOSED_NOTICE]: true })
		port.close()

		return
	}

	closed.addEventListener("abort", shutdown, { once: true })
	armIdle()

	const shutDown = new Promise<void>(resolve => {
		closed.addEventListener(
			"abort",
			() => {
				resolve()
			},
			{ once: true }
		)
	})

	const tracked = async (start: number, end: number, id: number): Promise<Uint8Array> => {
		const controller = new AbortController()

		reads.set(id, controller)
		clearTimeout(idle)

		try {
			return await read(start, end, AbortSignal.any([controller.signal, closed]))
		} finally {
			reads.delete(id)
			armIdle()
		}
	}
	const api: RangePortApi = {
		async read(start, end, id) {
			const bytes = await tracked(start, end, id)

			return Comlink.transfer(bytes, [bytes.buffer])
		},
		async readChecked(start, end, crc, id) {
			if (checksum === undefined) {
				throw new Error("this range port serves no checksum")
			}

			const bytes = await tracked(start, end, id)

			return Comlink.transfer({ bytes, crc: checksum(bytes, crc) }, [bytes.buffer])
		},
		cancel(id) {
			reads.get(id)?.abort()
		},
		close() {
			// After this call's own reply has been posted.
			setTimeout(() => {
				lifetime.abort()
			}, 0)
		},
		async holdLife(name, readerLock) {
			if (closed.aborted || !locksAvailable()) {
				return false
			}

			const held = Promise.withResolvers<boolean>()

			void navigator.locks
				.request(name, () => {
					held.resolve(true)

					return shutDown
				})
				.catch(() => {
					held.resolve(false)
				})

			const holding = await held.promise

			if (holding && readerLock !== undefined) {
				readerWatched = true
				clearTimeout(idle)
				// Granted once the reader lets go: it closed, or its worker died.
				void navigator.locks
					.request(readerLock, () => {
						lifetime.abort()
					})
					.catch(() => undefined)
			}

			return holding
		}
	}

	Comlink.expose(api, port)
}

function locksAvailable(): boolean {
	return "locks" in navigator
}

export class RangePortClosedError extends Error {
	public constructor() {
		super("range port closed")
		this.name = "RangePortClosedError"
	}
}

const CLOSE_REPLY_TIMEOUT_MS = 1000

// A port whose pending reads have all gone unanswered for this long has lost its server (a port closed
// without notice, which only some engines report). Measured from the last read that came back rather than
// from each read's start, so it is a lack of progress, not a slow read: reads in flight together share the
// bandwidth, and a long read is no more suspect than a short one. The SDK retries transient failures well
// within it.
export const RANGE_READ_TIMEOUT_MS = 60_000

// Shuts down the serving side of a port its reader never read through (rangePortReader's close() without making a
// reader, whose life locks a port nobody reads would only set up to let go of). The port is closed here either way.
export function closeRangePort(port: MessagePort): void {
	const remote = Comlink.wrap<RangePortApi>(port)

	void Promise.race([remote.close(), new Promise(resolve => setTimeout(resolve, CLOSE_REPLY_TIMEOUT_MS))])
		.catch(() => undefined)
		.finally(() => {
			remote[Comlink.releaseProxy]()
			port.close()
		})
}

export interface RangePortReader {
	readRange: AbortableReadRange
	// The bytes with the CRC-32 the server computed over them, continued from `crc` (a port served with a checksum).
	readChecked(start: number, end: number, crc: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; crc: number }>
	// Called once if the serving side goes away (not after this side's own close()).
	onLost(callback: () => void): void
	close(): void
}

function isClosedNotice(data: unknown): boolean {
	return typeof data === "object" && data !== null && CLOSED_NOTICE in data
}

// The reading end of a port served by exposeRangePort. Every read settles: with the bytes, when its
// signal aborts, when the server closes, or once the port has made no progress for RANGE_READ_TIMEOUT_MS.
// A server that goes away tears this end down too (its port, proxy and reader lock), as close() does.
export function rangePortReader(port: MessagePort): RangePortReader {
	const remote = Comlink.wrap<RangePortApi>(port)
	// Each pending read's failure, by its id.
	const pending = new Map<number, (error: Error) => void>()
	const lostCallbacks: (() => void)[] = []
	let nextId = 0
	let gone = false
	let closing = false
	let tornDown = false
	let stall: ReturnType<typeof setTimeout> | undefined
	// This side's own lock, held until the reader is done, tells the server the reader is still there.
	const readerDone = Promise.withResolvers<undefined>()
	// Re-armed by every read that comes back; with nothing pending there is nothing to wait on.
	const armStall = () => {
		clearTimeout(stall)
		stall =
			pending.size === 0
				? undefined
				: setTimeout(() => {
						stall = undefined

						for (const [id, fail] of [...pending]) {
							void remote.cancel(id).catch(() => undefined)
							fail(new Error("range read timed out"))
						}
					}, RANGE_READ_TIMEOUT_MS)
	}
	const teardown = () => {
		if (tornDown) {
			return
		}

		tornDown = true
		readerDone.resolve(undefined)
		remote[Comlink.releaseProxy]()
		port.close()
	}
	const lose = () => {
		if (gone) {
			return
		}

		gone = true
		clearTimeout(stall)
		stall = undefined

		if (!closing) {
			for (const callback of lostCallbacks.splice(0)) {
				callback()
			}
		}

		for (const fail of [...pending.values()]) {
			fail(new RangePortClosedError())
		}

		pending.clear()
		teardown()
	}

	port.addEventListener("message", event => {
		if (isClosedNotice(event.data)) {
			lose()
		}
	})
	// Where the engine reports a port closed on the other side.
	port.addEventListener("close", lose)

	// No engine reports a port whose serving worker died (crashed, terminated); the server's life lock is
	// released then, and this request for it is granted. Also granted after an orderly shutdown, which
	// has already been noticed by then.
	if (locksAvailable()) {
		const lifeLock = `filen-range-port-${crypto.randomUUID()}`
		const readerLock = `filen-range-reader-${crypto.randomUUID()}`
		const readerHeld = Promise.withResolvers<undefined>()

		void navigator.locks
			.request(readerLock, () => {
				readerHeld.resolve(undefined)

				return readerDone.promise
			})
			.catch(() => {
				readerHeld.resolve(undefined)
			})
		void readerHeld.promise
			.then(() => (gone ? false : remote.holdLife(lifeLock, readerLock)))
			.then(held =>
				held
					? navigator.locks.request(lifeLock, () => {
							lose()
						})
					: undefined
			)
			.catch(() => undefined)
	}

	// One read through `call`, settled by its answer, its signal, the server going away or the stall timeout.
	const pendingRead = <T>(signal: AbortSignal, call: (id: number) => Promise<T>): Promise<T> => {
		if (gone) {
			return Promise.reject(new RangePortClosedError())
		}

		signal.throwIfAborted()

		const id = nextId++

		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				void remote.cancel(id).catch(() => undefined)
				settle(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"))
			}
			const settle = (error: Error | null, value?: T) => {
				if (!pending.delete(id)) {
					return
				}

				signal.removeEventListener("abort", onAbort)

				if (error === null && value !== undefined) {
					armStall()
					resolve(value)
				} else {
					if (pending.size === 0) {
						armStall()
					}

					reject(error ?? new Error("range read failed"))
				}
			}
			const fail = (error: Error) => {
				settle(error)
			}

			pending.set(id, fail)

			if (stall === undefined) {
				armStall()
			}

			signal.addEventListener("abort", onAbort, { once: true })
			call(id).then(
				value => {
					settle(null, value)
				},
				(error: unknown) => {
					settle(error instanceof Error ? error : new Error(String(error)))
				}
			)
		})
	}

	return {
		readRange: (start, end, signal) => pendingRead(signal, id => remote.read(start, end, id)),
		readChecked: (start, end, crc, signal) => pendingRead(signal, id => remote.readChecked(start, end, crc, id)),
		onLost: callback => {
			lostCallbacks.push(callback)
		},
		close: () => {
			if (closing) {
				return
			}

			closing = true

			if (gone) {
				teardown()

				return
			}

			// A server already shut down from its side never answers.
			void Promise.race([remote.close(), new Promise(resolve => setTimeout(resolve, CLOSE_REPLY_TIMEOUT_MS))])
				.catch(() => undefined)
				.finally(lose)
		}
	}
}
