import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

import { File, Directory, Paths, fs } from "@/tests/mocks/expoFileSystem"
import { Logger } from "@/lib/logger"
import { LOGS_DIRECTORY } from "@/lib/storageRoots"
import * as logRedaction from "@/lib/logRedaction"

type Line = { t: number; l: string; tag: string; msg: string; data?: unknown }

function currentFile(): InstanceType<typeof File> {
	return new File(Paths.join(LOGS_DIRECTORY.uri, "current.ndjson"))
}

function readCurrentLines(): Line[] {
	const file = currentFile()

	if (!file.exists) {
		return []
	}

	return file
		.textSync()
		.split("\n")
		.filter(l => l.trim().length > 0)
		.map(l => JSON.parse(l) as Line)
}

function logFileNames(): string[] {
	if (!LOGS_DIRECTORY.exists) {
		return []
	}

	return LOGS_DIRECTORY.list()
		.filter(item => item instanceof File && item.name.endsWith(".ndjson"))
		.map(item => item.name)
}

function totalLogBytes(): number {
	if (!LOGS_DIRECTORY.exists) {
		return 0
	}

	let total = 0

	for (const item of LOGS_DIRECTORY.list()) {
		if (item instanceof File && item.name.endsWith(".ndjson")) {
			total += item.size
		}
	}

	return total
}

function makeLogger(): Logger {
	const logger = new Logger()

	// High flush delay so the debounce timer never fires mid-test; tests drive flushNow()/pendingMax.
	logger.configure({
		flushDelayMs: 1_000_000
	})

	return logger
}

beforeEach(() => {
	fs.clear()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("logger", () => {
	describe("capture scope (errors + warnings + breadcrumb ring)", () => {
		it("never persists standalone info/debug (no error to anchor them)", () => {
			const logger = makeLogger()

			logger.info("test", "just info")
			logger.debug("test", "just debug")
			logger.flushNow()

			expect(readCurrentLines()).toHaveLength(0)
		})

		it("persists warn and error", () => {
			const logger = makeLogger()

			logger.warn("test", "a warning")
			logger.error("test", "an error")
			logger.flushNow()

			expect(readCurrentLines().map(l => l.l)).toEqual(["warn", "error"])
		})

		it("drags the preceding breadcrumbs in front of an error for context", () => {
			const logger = makeLogger()

			logger.info("test", "step a")
			logger.info("test", "step b")
			logger.error("test", "boom")
			logger.flushNow()

			const lines = readCurrentLines()

			expect(lines.map(l => l.msg)).toEqual(["step a", "step b", "boom"])
			expect(lines.map(l => l.l)).toEqual(["info", "info", "error"])
		})

		it("does not re-dump the same breadcrumbs on the next error", () => {
			const logger = makeLogger()

			logger.info("test", "a")
			logger.error("test", "first")
			logger.flushNow()

			logger.error("test", "second")
			logger.flushNow()

			expect(readCurrentLines().map(l => l.msg)).toEqual(["a", "first", "second"])
		})

		it("respects the minLevel gate (gated breadcrumbs are not even ringed)", () => {
			const logger = makeLogger()

			logger.configure({ minLevel: "warn" })

			logger.info("test", "should be gated out")
			logger.error("test", "boom")
			logger.flushNow()

			expect(readCurrentLines().map(l => l.msg)).toEqual(["boom"])
		})
	})

	describe("batching", () => {
		it("defers the burst (pendingMax) flush off the calling frame, then writes on the next tick", async () => {
			vi.useFakeTimers()

			try {
				const logger = makeLogger()

				logger.configure({ pendingMax: 3 })

				logger.error("test", "1")
				logger.error("test", "2")
				logger.error("test", "3")

				// The pendingMax flush is scheduled on a 0ms timer, NOT run synchronously inside the
				// logging call — so nothing is on disk during the calling frame.
				expect(readCurrentLines()).toHaveLength(0)

				await vi.advanceTimersByTimeAsync(0)

				expect(readCurrentLines().map(l => l.msg)).toEqual(["1", "2", "3"])
			} finally {
				vi.useRealTimers()
			}
		})

		it("debounces a sub-threshold persisted entry until flushDelayMs (batched, infrequent I/O)", async () => {
			vi.useFakeTimers()

			try {
				const logger = new Logger()

				logger.configure({ flushDelayMs: 2000, pendingMax: 100 })

				logger.error("test", "later")

				expect(readCurrentLines()).toHaveLength(0)

				await vi.advanceTimersByTimeAsync(1999)

				expect(readCurrentLines()).toHaveLength(0)

				await vi.advanceTimersByTimeAsync(1)

				expect(readCurrentLines().map(l => l.msg)).toEqual(["later"])
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("redaction integration", () => {
		it("strips secrets but keeps file names in structured data", () => {
			const logger = makeLogger()

			logger.error("drive", "upload failed", { name: "salary.pdf", apiKey: "SECRET", size: 100 })
			logger.flushNow()

			const data = readCurrentLines()[0]!.data as Record<string, unknown>

			expect(data["name"]).toBe("salary.pdf")
			expect(data["size"]).toBe(100)
			expect(data["apiKey"]).toBe("[redacted]")
		})

		it("serializes bigint payloads instead of collapsing the whole line to [unserializable]", () => {
			const logger = makeLogger()

			logger.error("drive", "item sizes", { size: 4096n, count: 3 })
			logger.flushNow()

			const line = readCurrentLines()[0]!

			// The line is real (not the unserializable fallback) and the bigint survived.
			expect(line.msg).toBe("item sizes")

			const data = line.data as Record<string, unknown>

			expect(data["size"]).toBe("4096n")
			expect(data["count"]).toBe(3)
		})

		it("captureConsole persists console errors with redaction", () => {
			const logger = makeLogger()

			logger.captureConsole("error", ["network failed", { masterKeys: ["k1"] }])
			logger.flushNow()

			const line = readCurrentLines()[0]!

			expect(line.msg).toBe("network failed")

			const data = line.data as unknown[]

			expect((data[0] as Record<string, unknown>)["masterKeys"]).toBe("[redacted]")
		})
	})

	describe("rotation + size cap", () => {
		it("rotates with collision-free filenames under burst (unique monotonic seq)", () => {
			const logger = makeLogger()

			logger.configure({ maxFileBytes: 200, maxTotalBytes: 1_000_000 })

			for (let i = 0; i < 20; i++) {
				logger.error("test", `message number ${i} with some padding to grow the file past the cap`)
				logger.flushNow()
			}

			const rotatedNames = logFileNames().filter(name => name.startsWith("log-"))

			expect(rotatedNames.length).toBeGreaterThan(1)
			// The old bug used Date.now()-only names that collide within a millisecond and overwrite
			// each other; every rotated filename must now be unique.
			expect(new Set(rotatedNames).size).toBe(rotatedNames.length)
		})

		it("prunes OLDEST rotated files first and keeps the rotated total within maxTotalBytes", () => {
			const logger = makeLogger()

			logger.configure({ maxFileBytes: 120, maxTotalBytes: 600 })

			for (let i = 0; i < 60; i++) {
				logger.error("test", `entry ${String(i).padStart(3, "0")} padded out to force many rotations and pruning`)
				logger.flushNow()
			}

			const current = currentFile()
			const rotatedBytes = totalLogBytes() - (current.exists ? current.size : 0)

			// True ceiling: rotated files (active file excluded) stay within maxTotalBytes — no
			// "protect-newest" leftover from the file-cache eviction planner.
			expect(rotatedBytes).toBeLessThanOrEqual(600)

			// Oldest-first: the surviving rotated files are a contiguous NEWEST suffix of the sequence
			// space (a prefix of old files was evicted, none from the middle), and the oldest (seq 0) is gone.
			const seqs = logFileNames()
				.filter(name => name.startsWith("log-"))
				.map(name => Number(/^log-\d+-(\d+)\.ndjson$/.exec(name)?.[1] ?? -1))
				.sort((a, b) => a - b)

			expect(seqs.length).toBeGreaterThan(0)
			expect(seqs[0]).toBeGreaterThan(0)

			for (let i = 1; i < seqs.length; i++) {
				expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1)
			}
		})
	})

	describe("resilience", () => {
		it("never throws when the underlying write fails", () => {
			const logger = makeLogger()

			vi.spyOn(File.prototype, "write").mockImplementation(() => {
				throw new Error("disk full")
			})

			logger.error("test", "boom")

			expect(() => logger.flushNow()).not.toThrow()
		})

		it("never throws when rotation move or prune listing fails", () => {
			const logger = makeLogger()

			logger.configure({ maxFileBytes: 30, maxTotalBytes: 60 })

			// move (rotation) and list (prune) are both in the flush path beyond the write — a throw in
			// either must be swallowed by flushNow's guard, not escape to the caller.
			vi.spyOn(Directory.prototype, "list").mockImplementation(() => {
				throw new Error("list fail")
			})

			expect(() => {
				for (let i = 0; i < 5; i++) {
					logger.error("test", `padding message number ${i} to exceed the tiny file cap and rotate`)
					logger.flushNow()
				}
			}).not.toThrow()
		})

		it("a log call itself never throws even with a circular payload", () => {
			const logger = makeLogger()

			const circular: Record<string, unknown> = { name: "x" }

			circular["self"] = circular

			expect(() => logger.error("test", "boom", circular)).not.toThrow()
			expect(() => logger.flushNow()).not.toThrow()
		})
	})

	describe("readEntries (in-app viewer)", () => {
		it("returns persisted entries newest-first", () => {
			vi.useFakeTimers()

			try {
				const logger = makeLogger()

				vi.setSystemTime(1000)
				logger.error("alpha", "first")
				vi.setSystemTime(2000)
				logger.error("beta", "second")
				vi.setSystemTime(3000)
				logger.error("gamma", "third")
				logger.flushNow()

				const entries = logger.readEntries()

				expect(entries.map(e => e.msg)).toEqual(["third", "second", "first"])
				expect(entries[0]!.l).toBe("error")
				expect(entries[0]!.tag).toBe("gamma")
			} finally {
				vi.useRealTimers()
			}
		})

		it("caps at the requested limit, keeping the newest", () => {
			vi.useFakeTimers()

			try {
				const logger = makeLogger()

				for (let i = 0; i < 5; i++) {
					vi.setSystemTime(1000 + i)
					logger.error("t", `m${i}`)
				}

				logger.flushNow()

				expect(logger.readEntries(2).map(e => e.msg)).toEqual(["m4", "m3"])
			} finally {
				vi.useRealTimers()
			}
		})

		it("skips malformed / torn lines", () => {
			const logger = makeLogger()

			logger.error("t", "valid")
			logger.flushNow()

			// A partially-written final line (e.g. a crash mid-append).
			currentFile().write("this is not json\n", { append: true })

			expect(logger.readEntries().map(e => e.msg)).toEqual(["valid"])
		})

		it("returns [] when there are no logs", () => {
			expect(makeLogger().readEntries()).toEqual([])
		})

		it("returns [] after purge (disabled)", () => {
			const logger = makeLogger()

			logger.error("t", "boom")
			logger.flushNow()
			logger.purge()

			expect(logger.readEntries()).toEqual([])
		})
	})

	describe("serialization fallback + breadcrumb bound (regression guards)", () => {
		it("writes [unserializable] (never throws, keeps t/l/tag) when serialization fails", () => {
			const logger = makeLogger()

			// Force entryToLine's catch: redact returns a value JSON.stringify still chokes on (raw bigint).
			vi.spyOn(logRedaction, "redact").mockReturnValue({ msg: "x", data: 5n })

			expect(() => {
				logger.error("auth", "boom")
				logger.flushNow()
			}).not.toThrow()

			const lines = readCurrentLines()

			expect(lines).toHaveLength(1)
			expect(lines[0]?.l).toBe("error")
			expect(lines[0]?.tag).toBe("auth")
			expect(lines[0]?.msg).toBe("[unserializable]")
			expect(typeof lines[0]?.t).toBe("number")
		})

		it("breadcrumb ring is bounded — only the last N breadcrumbs are dragged before an error", () => {
			const logger = makeLogger()
			logger.configure({ breadcrumbCapacity: 3 })

			logger.info("t", "a")
			logger.info("t", "b")
			logger.info("t", "c")
			logger.info("t", "d")
			logger.info("t", "e")
			logger.error("t", "boom")
			logger.flushNow()

			expect(readCurrentLines().map(l => l.msg)).toEqual(["c", "d", "e", "boom"])
		})
	})

	describe("prod log-level default (constructor reads __DEV__)", () => {
		it("narrows minLevel to 'warn' when __DEV__ === false (prod)", () => {
			const g = globalThis as { __DEV__?: boolean }
			const saved = g.__DEV__
			g.__DEV__ = false

			try {
				expect(new Logger().minLevel).toBe("warn")
			} finally {
				g.__DEV__ = saved
			}
		})

		it("keeps minLevel 'debug' in dev (__DEV__ === true)", () => {
			const g = globalThis as { __DEV__?: boolean }
			const saved = g.__DEV__
			g.__DEV__ = true

			try {
				expect(new Logger().minLevel).toBe("debug")
			} finally {
				g.__DEV__ = saved
			}
		})
	})

	describe("purge", () => {
		it("deletes all on-disk logs, clears buffers, and disables further logging", () => {
			const logger = makeLogger()

			logger.info("test", "breadcrumb")
			logger.error("test", "boom")
			logger.flushNow()

			expect(logFileNames().length).toBeGreaterThan(0)

			logger.purge()

			expect(logFileNames().length).toBe(0)

			// After purge the logger is DISABLED. A subsequent log (e.g. a console.* during the logout
			// wipe) must NOT re-create the logs directory — otherwise decrypted-at-rest data is
			// resurrected on disk after logout.
			logger.error("test", "after purge")
			logger.flushNow()

			expect(logFileNames().length).toBe(0)
			expect(readCurrentLines()).toHaveLength(0)
		})
	})
})
