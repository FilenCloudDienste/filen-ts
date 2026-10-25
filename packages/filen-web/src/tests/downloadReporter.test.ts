import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DownloadReporter } from "@/lib/sw/downloadReporter"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { SW_DOWNLOAD_HEARTBEAT_MS, type SwDownloadStatus } from "@/lib/sw/protocol"

// A watcher port: records what the worker reports and whether it was closed.
function fakePort() {
	const received: SwDownloadStatus[] = []
	let closed = false

	return {
		port: {
			postMessage: (status: SwDownloadStatus) => {
				if (!closed) {
					received.push(status)
				}
			},
			close: () => {
				closed = true
			}
		} as unknown as MessagePort,
		received,
		isClosed: () => closed
	}
}

const failure = { type: "failed" as const, error: plainErrorDTO("chunk failed") }

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("DownloadReporter", () => {
	it("reports progress, then the outcome, and closes the watcher", () => {
		const reporter = new DownloadReporter(8)
		const watcher = fakePort()

		reporter.attach("a", watcher.port, true)
		const stream = reporter.begin("a")
		stream.progress(512, 1_024)
		stream.end({ type: "done" })

		expect(watcher.received).toEqual([
			{ type: "progress", bytes: 0, total: null },
			{ type: "progress", bytes: 512, total: 1_024 },
			{ type: "done" }
		])
		expect(watcher.isClosed()).toBe(true)
	})

	it("coalesces a burst of progress reports and still sends the last one before the outcome", () => {
		const reporter = new DownloadReporter(8)
		const watcher = fakePort()

		reporter.attach("a", watcher.port, true)
		const stream = reporter.begin("a")

		for (let bytes = 65_536; bytes <= 65_536 * 32; bytes += 65_536) {
			stream.progress(bytes, 65_536 * 32)
		}

		expect(watcher.received).toEqual([
			{ type: "progress", bytes: 0, total: null },
			{ type: "progress", bytes: 65_536, total: 65_536 * 32 }
		])

		stream.end({ type: "done" })

		expect(watcher.received.slice(2)).toEqual([{ type: "progress", bytes: 65_536 * 32, total: 65_536 * 32 }, { type: "done" }])
	})

	it("replays the latest status to a watcher that attaches after the stream began", () => {
		const reporter = new DownloadReporter(8)
		const stream = reporter.begin("a")

		stream.progress(300, null)
		stream.end(failure)

		const watcher = fakePort()
		reporter.attach("a", watcher.port, true)

		expect(watcher.received).toEqual([failure])
	})

	it("says once that the browser reads the body, to a watcher attaching later too, beside the repeated progress", () => {
		const reporter = new DownloadReporter(8)
		const early = fakePort()

		reporter.attach("a", early.port, true)

		const stream = reporter.begin("a")

		stream.reading()
		stream.reading()
		expect(early.received).toEqual([{ type: "progress", bytes: 0, total: null }, { type: "reading" }])

		// The heartbeat repeats the progress, never the reading.
		vi.advanceTimersByTime(SW_DOWNLOAD_HEARTBEAT_MS)
		expect(early.received.at(-1)).toEqual({ type: "progress", bytes: 0, total: null })

		const late = fakePort()

		reporter.attach("a", late.port, true)
		expect(late.received).toEqual([{ type: "reading" }, { type: "progress", bytes: 0, total: null }])
	})

	it("fails a watch for a download the restarted worker no longer knows", () => {
		const reporter = new DownloadReporter(8)
		const watcher = fakePort()

		reporter.attach("gone", watcher.port, false)

		expect(watcher.received).toEqual([{ type: "failed", error: expect.objectContaining({ species: "plain" }) as unknown }])
		expect(watcher.isClosed()).toBe(true)
	})

	it("settles on the last of two concurrent streams, a completed one winning", () => {
		const reporter = new DownloadReporter(8)
		const watcher = fakePort()

		reporter.attach("a", watcher.port, true)
		const first = reporter.begin("a")
		const second = reporter.begin("a")

		second.end({ type: "done" })
		expect(watcher.received.at(-1)?.type).toBe("progress")

		first.end(failure)
		expect(watcher.received.at(-1)).toEqual({ type: "done" })
	})

	it("cuts a running stream off on cancel and marks it requested", () => {
		const reporter = new DownloadReporter(8)
		const stream = reporter.begin("a")
		const abort = vi.fn()

		stream.onCancelRequest(abort)
		reporter.cancel("a")

		expect(abort).toHaveBeenCalledOnce()
		expect(stream.cancelRequested).toBe(true)
	})

	it("repeats the latest progress while a stream is stalled, and stops once it ends", () => {
		const reporter = new DownloadReporter(8)
		const watcher = fakePort()

		reporter.attach("a", watcher.port, true)
		const stream = reporter.begin("a")
		stream.progress(100, 1_000)
		const before = watcher.received.length

		vi.advanceTimersByTime(SW_DOWNLOAD_HEARTBEAT_MS * 2)
		expect(watcher.received.length).toBe(before + 2)

		stream.end({ type: "done" })
		const after = watcher.received.length

		vi.advanceTimersByTime(SW_DOWNLOAD_HEARTBEAT_MS * 2)
		expect(watcher.received.length).toBe(after)
	})

	it("drops the oldest idle entry past its bound, never a streaming one", () => {
		const reporter = new DownloadReporter(2)
		const streaming = fakePort()
		const idle = fakePort()

		reporter.attach("streaming", streaming.port, true)
		reporter.begin("streaming")
		reporter.attach("idle", idle.port, true)
		reporter.begin("c")

		expect(idle.isClosed()).toBe(true)
		expect(streaming.isClosed()).toBe(false)
	})
})
