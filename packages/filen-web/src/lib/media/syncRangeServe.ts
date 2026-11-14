import { serveSyncRange, type SyncRangeServerStats } from "@filen/office/dom/pdfedit"

// The SDK worker's end of a sync range bridge (office dom/pdfedit/syncRange.ts): serves one file's decrypted blocks
// into the shared buffer the PDF engine reads from synchronously. Lives until the reader closes, the page that opened
// it lets go of `readerLock` (it closed the engine, or the page died), or `lifetime` aborts (a cancelled preview
// token, sign-out). `release` runs once it has shut down and no read is still running on the client.

export interface SyncRangeServeDeps {
	// Exactly bytes [start, end) of the file; rejects once `signal` aborts.
	readonly read: (start: number, end: number, signal: AbortSignal) => Promise<Uint8Array>
	readonly length: number
	readonly lifetime: AbortController
	readonly readerLock: string
	readonly release?: () => void
	// Web Locks, where the realm has them.
	readonly locks?: Pick<LockManager, "request">
}

export function serveFileSyncRange(buffer: SharedArrayBuffer, port: MessagePort, deps: SyncRangeServeDeps): SyncRangeServerStats {
	const { lifetime } = deps
	let reading = 0
	let release = deps.release
	const releaseIfDone = (): void => {
		if (release !== undefined && reading === 0 && lifetime.signal.aborted) {
			release()
			release = undefined
		}
	}

	lifetime.signal.addEventListener("abort", releaseIfDone, { once: true })

	const stats = serveSyncRange(
		buffer,
		port,
		{
			length: deps.length,
			read: async (start, end) => {
				// After shutdown nothing touches a client that may already be freed.
				lifetime.signal.throwIfAborted()
				reading++

				try {
					return await deps.read(start, end, lifetime.signal)
				} finally {
					reading--
					releaseIfDone()
				}
			}
		},
		{
			lifetime: lifetime.signal,
			readAhead: 3,
			onReaderClose: () => {
				lifetime.abort()
			}
		}
	)

	// Granted once the page lets go of it.
	void deps.locks
		?.request(deps.readerLock, () => {
			lifetime.abort()
		})
		.catch(() => undefined)

	return stats
}
