import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFileLog, formatLogLine, LOG_FILE_MAX_BYTES, LOG_LINE_MAX_LENGTH } from "../main/fileLog.ts"

const AT = new Date("2026-10-26T12:00:00.000Z")

describe("formatLogLine", () => {
	it("stamps, levels, redacts and keeps each entry on one bounded line", () => {
		expect(formatLogLine(AT, "warn", 'a\nb {"apiKey":"x"}')).toBe('[2026-10-26T12:00:00.000Z] WARN a b {"apiKey":[redacted]}\n')
		expect(formatLogLine(AT, "info", "x".repeat(LOG_LINE_MAX_LENGTH * 2)).length).toBe(LOG_LINE_MAX_LENGTH + 1)
	})
})

describe("createFileLog", () => {
	let directory = ""

	beforeEach(async () => {
		directory = await mkdtemp(path.join(os.tmpdir(), "filen-log-"))
	})

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true })
	})

	it("appends lines owner-only and reads them back in order", async () => {
		const log = createFileLog(path.join(directory, "logs"), () => AT)

		log.write("info", "one")
		log.write("warn", "two")

		expect(await log.read()).toBe("[2026-10-26T12:00:00.000Z] INFO one\n[2026-10-26T12:00:00.000Z] WARN two\n")
		expect((await stat(path.join(directory, "logs", "main.log"))).mode & 0o777).toBe(0o600)
	})

	it("writes pending lines at once on flushSync, in order after what was flushed before", async () => {
		const log = createFileLog(path.join(directory, "logs"), () => AT)
		const file = path.join(directory, "logs", "main.log")

		log.write("info", "one")
		await log.read()
		log.write("info", "two")
		log.flushSync()

		expect(readFileSync(file, "utf8")).toBe("[2026-10-26T12:00:00.000Z] INFO one\n[2026-10-26T12:00:00.000Z] INFO two\n")
		expect(await log.read()).toBe(readFileSync(file, "utf8"))
	})

	it("creates the directory owner-only on a flushSync before any batch", () => {
		const log = createFileLog(path.join(directory, "logs"), () => AT)

		log.write("warn", "first")
		log.flushSync()

		expect(readFileSync(path.join(directory, "logs", "main.log"), "utf8")).toBe("[2026-10-26T12:00:00.000Z] WARN first\n")
		expect(statSync(path.join(directory, "logs", "main.log")).mode & 0o777).toBe(0o600)
		expect(statSync(path.join(directory, "logs")).mode & 0o777).toBe(0o700)
	})

	it("rotates into at most two files, each within the size bound, keeping the newest lines", async () => {
		const log = createFileLog(directory, () => AT)
		const message = "x".repeat(1000)
		const lines = Math.ceil((LOG_FILE_MAX_BYTES * 3) / message.length)

		for (let index = 0; index < lines; index++) {
			log.write("info", `${String(index)} ${message}`)
			// Flushed in several batches, as a running app would.
			if (index % 200 === 0) {
				await log.read()
			}
		}

		const content = await log.read()

		expect((await readdir(directory)).sort()).toEqual(["main.1.log", "main.log"])

		for (const file of ["main.1.log", "main.log"]) {
			expect((await stat(path.join(directory, file))).size).toBeLessThanOrEqual(LOG_FILE_MAX_BYTES)
		}

		expect(content.endsWith(`] INFO ${String(lines - 1)} ${message}\n`)).toBe(true)
		expect(content).not.toContain("] INFO 0 ")
	})

	it("keeps a burst larger than a file within the bound", async () => {
		const log = createFileLog(directory, () => AT)

		for (let index = 0; index < 3000; index++) {
			log.write("info", `${String(index)} ${"y".repeat(1000)}`)
		}

		await log.read()
		expect((await stat(path.join(directory, "main.log"))).size).toBeLessThanOrEqual(LOG_FILE_MAX_BYTES)
	})

	it("clears the directory with the lines not written yet, and starts a new file after", async () => {
		const logs = path.join(directory, "logs")
		const log = createFileLog(logs, () => AT)

		log.write("info", "before")
		await log.read()
		await writeFile(path.join(logs, "rclone.log"), "rclone\n")
		log.write("info", "dropped")
		await log.clear(target => rm(target, { recursive: true, force: true }))

		expect(existsSync(logs)).toBe(false)

		log.write("info", "after")
		expect(await log.read()).toBe("[2026-10-26T12:00:00.000Z] INFO after\n")
		expect(await readdir(logs)).toEqual(["main.log"])
	})

	it("rejects a clear that failed, and keeps logging", async () => {
		const log = createFileLog(path.join(directory, "logs"), () => AT)

		await expect(log.clear(() => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })))).rejects.toThrow("busy")

		log.write("info", "still")
		expect(await log.read()).toBe("[2026-10-26T12:00:00.000Z] INFO still\n")
	})
})
