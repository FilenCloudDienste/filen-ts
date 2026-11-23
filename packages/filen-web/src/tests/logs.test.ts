import { describe, expect, it, vi } from "vitest"
import { LOG_RING_MAX, log, type LogEntry } from "@/lib/log"
import {
	collectLogs,
	formatLogEntry,
	formatLogEntries,
	logsExportFilename,
	logsExportText,
	mergeLogEntries
} from "@/features/settings/lib/logs"

// The global setup mocks this module; the ring buffer test needs the real one.
vi.unmock("@/lib/log")

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
	return { t: Date.parse("2026-01-02T03:04:05.000Z"), level: "info", scope: "boot", msg: "ready", ...overrides }
}

describe("formatLogEntry", () => {
	it("formats as [ISO time] LEVEL [scope] message, level uppercased", () => {
		expect(formatLogEntry(entry())).toBe("[2026-01-02T03:04:05.000Z] INFO [boot] ready")
	})

	it("uppercases every level", () => {
		expect(formatLogEntry(entry({ level: "warn" }))).toContain("WARN")
		expect(formatLogEntry(entry({ level: "error" }))).toContain("ERROR")
		expect(formatLogEntry(entry({ level: "debug" }))).toContain("DEBUG")
	})
})

describe("formatLogEntries", () => {
	it("joins entries one per line, in the given order", () => {
		const first = entry({ msg: "first" })
		const second = entry({ msg: "second" })

		expect(formatLogEntries([first, second])).toBe(`${formatLogEntry(first)}\n${formatLogEntry(second)}`)
	})

	it("is an empty string for no entries", () => {
		expect(formatLogEntries([])).toBe("")
	})
})

describe("logsExportText", () => {
	it("opens with the build, the browser and the export time, then the entries", () => {
		const first = entry({ msg: "first" })
		const text = logsExportText([first], {
			build: "abc123",
			userAgent: "TestBrowser/1.0",
			exportedAt: new Date("2026-03-04T05:06:07.000Z")
		})

		expect(text).toBe(`Filen web abc123\nTestBrowser/1.0\nExported 2026-03-04T05:06:07.000Z\n\n${formatLogEntry(first)}`)
	})
})

describe("logsExportFilename", () => {
	it("is a .txt filename carrying a timestamp", () => {
		expect(logsExportFilename()).toMatch(/^filen-web-logs\.\d+\.txt$/)
	})
})

describe("log ring buffer", () => {
	it("keeps exactly LOG_RING_MAX entries, dropping the oldest", () => {
		const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined)

		for (let i = 0; i < LOG_RING_MAX + 5; i++) {
			log.debug("ring", `entry ${i.toString()}`)
		}

		spy.mockRestore()

		const entries = log.dump()

		expect(entries).toHaveLength(LOG_RING_MAX)
		expect(entries[0]?.msg).toBe("entry 5")
		expect(entries.at(-1)?.msg).toBe(`entry ${(LOG_RING_MAX + 4).toString()}`)
	})
})

describe("mergeLogEntries", () => {
	it("orders page and worker entries by time and tags each worker entry's scope with its realm", () => {
		const page = [entry({ t: 10, scope: "drive", msg: "page first" }), entry({ t: 40, scope: "drive", msg: "page last" })]
		const merged = mergeLogEntries(page, [
			{ realm: "sdk-worker", entries: [entry({ t: 20, scope: "sdk.worker", msg: "listDir" })] },
			{ realm: "service-worker", entries: [entry({ t: 30, scope: "sw", msg: "stream failed" })] }
		])

		expect(merged.map(e => [e.t, e.scope, e.msg])).toEqual([
			[10, "drive", "page first"],
			[20, "sdk-worker/sdk.worker", "listDir"],
			[30, "service-worker/sw", "stream failed"],
			[40, "drive", "page last"]
		])
	})

	it("leaves the realm's own entries untouched", () => {
		const own = entry({ t: 5, scope: "db.worker" })

		mergeLogEntries([], [{ realm: "db-worker", entries: [own] }])

		expect(own.scope).toBe("db.worker")
	})
})

describe("collectLogs", () => {
	it("pulls the SDK worker's and the db worker's rings and merges them with the page's", async () => {
		const merged = await collectLogs([entry({ t: 3, scope: "page" })], {
			sdk: { dumpLogs: () => Promise.resolve([entry({ t: 1, scope: "sdk.worker" })]) },
			storage: () => Promise.resolve({ api: { dumpLogs: () => Promise.resolve([entry({ t: 2, scope: "db.worker" })]) } })
		})

		expect(merged.map(e => e.scope)).toEqual(["sdk-worker/sdk.worker", "db-worker/db.worker", "page"])
	})

	it("keeps the page's entries when a worker cannot answer", async () => {
		const merged = await collectLogs([entry({ scope: "page" })], {
			sdk: { dumpLogs: () => Promise.reject(new Error("gone")) },
			storage: () => Promise.reject(new Error("no db leader after 10s"))
		})

		expect(merged.map(e => e.scope)).toEqual(["page"])
	})

	const noWorkers = {
		sdk: { dumpLogs: () => Promise.resolve([]) },
		storage: () => Promise.resolve({ api: { dumpLogs: () => Promise.resolve([]) } })
	}

	function stubController(postMessage: (message: unknown, transfer: MessagePort[]) => void): void {
		vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage } } })
	}

	it("merges the controlling service worker's ring, answered on the transferred port", async () => {
		stubController((message, [port]) => {
			expect(message).toEqual({ type: "FILEN_SW_DUMP_LOGS" })
			port?.postMessage([entry({ t: 1, scope: "sw" })])
		})

		try {
			const merged = await collectLogs([entry({ t: 2, scope: "page" })], noWorkers)

			expect(merged.map(e => e.scope)).toEqual(["service-worker/sw", "page"])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("gives up on a silent service worker after the timeout and closes its port", async () => {
		vi.useFakeTimers()
		stubController(() => undefined)
		const close = vi.spyOn(MessagePort.prototype, "close")

		try {
			const pending = collectLogs([entry({ scope: "page" })], noWorkers)

			await vi.advanceTimersByTimeAsync(2_000)

			expect((await pending).map(e => e.scope)).toEqual(["page"])
			expect(close).toHaveBeenCalledTimes(1)
		} finally {
			close.mockRestore()
			vi.unstubAllGlobals()
			vi.useRealTimers()
		}
	})
})
