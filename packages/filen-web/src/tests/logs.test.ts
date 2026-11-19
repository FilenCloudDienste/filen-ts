import { describe, expect, it, vi } from "vitest"
import { LOG_RING_MAX, log, type LogEntry } from "@/lib/log"
import { formatLogEntry, formatLogEntries, logsExportFilename } from "@/features/settings/lib/logs"

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
