import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises"
import path from "node:path"
import { errorCode } from "./atomicFile.ts"
import { redact } from "./redact.ts"

// The shell's own log: two files at most, each at most this size. When the current one would outgrow it, it becomes
// the previous one (replacing the older) and a new one starts.
export const LOG_FILE_MAX_BYTES = 1024 * 1024
// A longer line is cut, so one message can never take a file's whole budget.
export const LOG_LINE_MAX_LENGTH = 4096

export type LogLevel = "info" | "warn" | "error"

export interface FileLog {
	write(level: LogLevel, message: string): void
	// Both files, oldest line first, once everything written so far is on disk.
	read(): Promise<string>
}

export function formatLogLine(at: Date, level: LogLevel, message: string): string {
	const line = `[${at.toISOString()}] ${level.toUpperCase()} ${redact(message).replaceAll(/\r?\n/g, " ")}`

	return `${line.length > LOG_LINE_MAX_LENGTH ? `${line.slice(0, LOG_LINE_MAX_LENGTH - 1)}…` : line}\n`
}

// Lines are batched and appended off the caller's path, one batch at a time. A failing disk never throws into the
// caller: the batch is dropped and the failure goes to the console.
export function createFileLog(directory: string, now: () => Date = () => new Date()): FileLog {
	const current = path.join(directory, "main.log")
	const previous = path.join(directory, "main.1.log")
	let size: number | null = null
	let pending = ""
	let tail: Promise<void> = Promise.resolve()
	let scheduled = false

	async function flush(): Promise<void> {
		scheduled = false

		let data = Buffer.from(pending)

		pending = ""

		if (data.length === 0) {
			return
		}

		// A burst larger than a file keeps its newest whole lines.
		if (data.length > LOG_FILE_MAX_BYTES) {
			data = data.subarray(data.length - LOG_FILE_MAX_BYTES)
			data = data.subarray(data.indexOf(0x0a) + 1)
		}

		const bytes = data.length

		try {
			if (size === null) {
				await mkdir(directory, { recursive: true, mode: 0o700 })
				size = await stat(current).then(
					stats => stats.size,
					() => 0
				)
			}

			if (size > 0 && size + bytes > LOG_FILE_MAX_BYTES) {
				await rename(current, previous)
				size = 0
			}

			await appendFile(current, data, { mode: 0o600 })
			size += bytes
		} catch (error) {
			// The size is unknown after a failed write; the next batch re-reads it.
			size = null
			console.warn(`log write failed: ${errorCode(error)}`)
		}
	}

	function enqueue(): Promise<void> {
		tail = tail.then(flush)

		return tail
	}

	async function readOptional(file: string): Promise<string> {
		try {
			return await readFile(file, "utf8")
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				return ""
			}

			throw error
		}
	}

	return {
		write: (level, message) => {
			pending += formatLogLine(now(), level, message)

			// Bounds what waits in memory while the disk is slow; flush trims it to the byte budget.
			if (pending.length > LOG_FILE_MAX_BYTES) {
				pending = pending.slice(pending.indexOf("\n", pending.length - LOG_FILE_MAX_BYTES) + 1)
			}

			if (!scheduled) {
				scheduled = true
				setImmediate(() => {
					void enqueue()
				})
			}
		},
		read: async () => {
			await enqueue()

			return (await readOptional(previous)) + (await readOptional(current))
		}
	}
}
