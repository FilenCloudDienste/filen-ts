import { open, readFile, rename, rm } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

export interface AtomicFile {
	// null when the file does not exist; any other read error throws.
	read(): Promise<Buffer | null>
	write(data: Buffer): Promise<void>
	remove(): Promise<void>
	// Moves the file to `<file>.unreadable`, keeping what could not be read. Every real file has it; in-memory fakes
	// may leave it out.
	setAside?(): Promise<void>
}

export function errorCode(error: unknown): string {
	return error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : "unknown"
}

// What a log line says about a failure: an error's message, anything else as text.
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// An error that logs as `code` through errorCode: for failures main raises itself, whose reason is the message.
export function codedError(code: string): Error {
	return Object.assign(new Error(code), { code })
}

export interface AtomicFileDeps {
	rename: (from: string, to: string) => Promise<void>
	platform: NodeJS.Platform
	delay: (ms: number) => Promise<unknown>
}

const DEFAULT_DEPS: AtomicFileDeps = { rename, platform: process.platform, delay: sleep }

// Windows refuses a rename over a file a scanner or indexer holds open for a moment: retried, growing, about a second
// in total. Only these codes, so a real permission error still surfaces at once.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
export const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 300, 400] as const

async function renameOver(deps: AtomicFileDeps, temp: string, file: string): Promise<void> {
	for (let tries = 0; ; tries++) {
		try {
			await deps.rename(temp, file)

			return
		} catch (error) {
			const delay = RENAME_RETRY_DELAYS_MS[tries]

			if (deps.platform !== "win32" || delay === undefined || !RENAME_RETRY_CODES.has(errorCode(error))) {
				throw error
			}

			await deps.delay(delay)
		}
	}
}

// Owner-only. The file is written to a sibling and renamed over the old one, so a crash mid-write never leaves half a
// file. Writers must not overlap: they share the sibling (a retried rename stays inside the one write).
export function atomicFile(file: string, deps: AtomicFileDeps = DEFAULT_DEPS): AtomicFile {
	return {
		read: async () => {
			try {
				return await readFile(file)
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					return null
				}

				throw error
			}
		},
		write: async data => {
			const temp = `${file}.tmp`
			const handle = await open(temp, "w", 0o600)

			try {
				await handle.writeFile(data)
				await handle.sync()
			} finally {
				await handle.close()
			}

			try {
				await renameOver(deps, temp, file)
			} catch (error) {
				await rm(temp, { force: true })

				throw error
			}
		},
		remove: () => rm(file, { force: true }),
		setAside: () => deps.rename(file, `${file}.unreadable`)
	}
}

export interface StoreFileRead<T> {
	// What the startup read gave: the parsed content, or `fallback` when the read threw.
	value: T
	// Inside the store's queue, before every write: null, except before the first write after a startup read that
	// threw, which reads again and answers the content to adopt (null when it still cannot be read).
	beforeWrite(): Promise<T | null>
}

// A store's file read once at startup. A read that threw (a missing file does not) left the file as it was: the store
// starts from `fallback`, and its first write reads again first. The content is adopted when it reads now; otherwise
// the file is moved aside, so no write replaces what could not be read and the store goes on from `fallback`.
export async function readStoreFile<T>(
	file: AtomicFile,
	parse: (data: string | null) => T,
	fallback: T,
	what: string,
	warn: (message: string) => void
): Promise<StoreFileRead<T>> {
	const read = async () => parse((await file.read())?.toString("utf8") ?? null)
	let unread = false
	let value = fallback

	try {
		value = await read()
	} catch (error) {
		warn(`${what} unreadable, starting empty until it is read again: ${errorCode(error)}`)
		unread = true
	}

	return {
		value,
		beforeWrite: async () => {
			if (!unread) {
				return null
			}

			unread = false

			try {
				const reread = await read()

				warn(`${what} read on the second try`)

				return reread
			} catch (error) {
				warn(`${what} still unreadable, set aside: ${errorCode(error)}`)
				await file.setAside?.().catch((asideError: unknown) => {
					warn(`${what} not set aside: ${errorCode(asideError)}`)
				})

				return null
			}
		}
	}
}
