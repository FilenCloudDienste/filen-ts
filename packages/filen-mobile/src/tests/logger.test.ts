import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

import { File, Paths, fs } from "@/tests/mocks/expoFileSystem"
import { Logger } from "@/lib/logger"
import { LOGS_DIRECTORY } from "@/lib/storageRoots"

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
		it("auto-flushes once pending reaches pendingMax (no manual flush)", () => {
			const logger = makeLogger()

			logger.configure({ pendingMax: 3 })

			logger.error("test", "1")
			logger.error("test", "2")
			logger.error("test", "3")

			expect(readCurrentLines().map(l => l.msg)).toEqual(["1", "2", "3"])
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
		it("rotates the current file once it exceeds maxFileBytes", () => {
			const logger = makeLogger()

			logger.configure({ maxFileBytes: 200, maxTotalBytes: 1_000_000 })

			for (let i = 0; i < 20; i++) {
				logger.error("test", `message number ${i} with some padding to grow the file`)
				logger.flushNow()
			}

			expect(logFileNames().some(name => name.startsWith("log-"))).toBe(true)
		})

		it("prunes oldest rotated files to stay near the total size cap", () => {
			const logger = makeLogger()

			logger.configure({ maxFileBytes: 120, maxTotalBytes: 600 })

			for (let i = 0; i < 60; i++) {
				logger.error("test", `entry ${i} padded out to force many rotations and pruning`)
				logger.flushNow()
			}

			// current.ndjson is always kept; rotated files are capped near maxTotalBytes.
			expect(totalLogBytes()).toBeLessThan(600 + 120 * 3)
			expect(logFileNames().length).toBeLessThan(12)
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

		it("a log call itself never throws even with a circular payload", () => {
			const logger = makeLogger()

			const circular: Record<string, unknown> = { name: "x" }

			circular["self"] = circular

			expect(() => logger.error("test", "boom", circular)).not.toThrow()
			expect(() => logger.flushNow()).not.toThrow()
		})
	})

	describe("purge", () => {
		it("deletes all on-disk logs and clears buffers", () => {
			const logger = makeLogger()

			logger.info("test", "breadcrumb")
			logger.error("test", "boom")
			logger.flushNow()

			expect(logFileNames().length).toBeGreaterThan(0)

			logger.purge()

			expect(logFileNames().length).toBe(0)

			// A subsequent error after purge starts a clean file with no resurrected breadcrumbs.
			logger.error("test", "after purge")
			logger.flushNow()

			expect(readCurrentLines().map(l => l.msg)).toEqual(["after purge"])
		})
	})
})
