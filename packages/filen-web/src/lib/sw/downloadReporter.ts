import type { ErrorDTO } from "@/lib/sdk/errors"
import { SW_DOWNLOAD_HEARTBEAT_MS, type SwDownloadStatus } from "@/lib/sw/protocol"

// The service worker's side of a browser-streamed download's outcome. The browser's download manager
// owns the save, so without this the page never learns whether the stream finished, failed or was
// cancelled from the browser's own download UI. Split out of sw.ts so it is unit-testable.
//
// One entry per download id. Statuses go to the page's watcher port once it attaches (the watch
// message can arrive after the stream has begun, so the latest status is replayed on attach). Only a
// full-body stream reports: a ranged request is a probe or a media seek, not the download. One id can be
// streamed more than once at a time (a repeated GET), so the outcome is settled by the last stream to
// end, and a completed stream wins over one cut short.
interface Entry {
	port: MessagePort | null
	last: SwDownloadStatus | null
	streams: number
	completed: boolean
	cancelRequested: boolean
	aborts: Set<() => void>
	heartbeat: ReturnType<typeof setInterval> | null
}

export interface ReportedStream {
	progress(bytes: number, total: number | null): void
	// `abort` cuts this stream off; called when the page cancels the download.
	onCancelRequest(abort: () => void): void
	// Whether the page asked for the cancel, so a failure that follows reports as a cancel.
	readonly cancelRequested: boolean
	end(outcome: { type: "done" } | { type: "failed"; error: ErrorDTO }): void
}

export class DownloadReporter {
	private readonly entries = new Map<string, Entry>()
	private readonly max: number

	public constructor(max: number) {
		this.max = max
	}

	private entry(id: string): Entry {
		let entry = this.entries.get(id)

		if (entry === undefined) {
			entry = { port: null, last: null, streams: 0, completed: false, cancelRequested: false, aborts: new Set(), heartbeat: null }
			this.entries.set(id, entry)
			this.evict()
		}

		return entry
	}

	// Bounded like the download registry: a watcher that never attaches (the page closed) must not
	// keep its entry forever. An entry still streaming is never the one dropped.
	private evict(): void {
		if (this.entries.size <= this.max) {
			return
		}

		for (const [id, entry] of this.entries) {
			if (entry.streams === 0) {
				this.drop(id, entry)

				return
			}
		}
	}

	private drop(id: string, entry: Entry): void {
		if (entry.heartbeat !== null) {
			clearInterval(entry.heartbeat)
		}

		entry.port?.close()
		this.entries.delete(id)
	}

	private post(id: string, entry: Entry, status: SwDownloadStatus): void {
		entry.last = status
		entry.port?.postMessage(status)

		// A final status delivered to a watcher ends the entry; one nobody watches yet waits for the attach.
		if (status.type !== "progress" && entry.port !== null) {
			this.drop(id, entry)
		}
	}

	public attach(id: string, port: MessagePort, known: boolean): void {
		const existing = this.entries.get(id)

		if (existing === undefined && !known) {
			// The worker restarted since the registration (its globals are gone), so this download can
			// never stream. Saying so now fails the row instead of leaving it waiting out the stall timer.
			port.postMessage({
				type: "failed",
				error: { species: "plain", message: "download is no longer available", label: "download is no longer available" }
			} satisfies SwDownloadStatus)
			port.close()

			return
		}

		const entry = existing ?? this.entry(id)

		entry.port?.close()
		entry.port = port

		if (entry.last !== null) {
			this.post(id, entry, entry.last)
		}
	}

	public cancel(id: string): void {
		const entry = this.entries.get(id)

		if (entry === undefined) {
			return
		}

		entry.cancelRequested = true

		for (const abort of entry.aborts) {
			abort()
		}
	}

	public begin(id: string): ReportedStream {
		const entry = this.entry(id)
		let abort: (() => void) | null = null
		let ended = false

		entry.streams++
		// The page treats a long silence as a dead worker, so a stream that is alive but stalled (the SDK
		// retrying a chunk) still says so.
		entry.heartbeat ??= setInterval(() => {
			if (entry.last?.type === "progress") {
				entry.port?.postMessage(entry.last)
			}
		}, SW_DOWNLOAD_HEARTBEAT_MS)
		this.post(id, entry, { type: "progress", bytes: 0, total: null })

		return {
			progress: (bytes, total) => {
				if (!ended) {
					this.post(id, entry, { type: "progress", bytes, total })
				}
			},
			onCancelRequest: fn => {
				abort = fn
				entry.aborts.add(fn)

				if (entry.cancelRequested) {
					fn()
				}
			},
			get cancelRequested() {
				return entry.cancelRequested
			},
			end: outcome => {
				if (ended) {
					return
				}

				ended = true
				entry.streams--

				if (abort !== null) {
					entry.aborts.delete(abort)
				}

				if (outcome.type === "done") {
					entry.completed = true
				}

				if (entry.streams > 0) {
					return
				}

				if (entry.heartbeat !== null) {
					clearInterval(entry.heartbeat)
					entry.heartbeat = null
				}

				this.post(id, entry, entry.completed ? { type: "done" } : outcome)
			}
		}
	}

	// Sign-out: no watcher keeps listening to a session that is gone.
	public clear(): void {
		for (const [id, entry] of [...this.entries]) {
			this.drop(id, entry)
		}
	}
}
