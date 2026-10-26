import { open, readFile, rename, rm } from "node:fs/promises"

export interface AtomicFile {
	// null when the file does not exist; any other read error throws.
	read(): Promise<Buffer | null>
	write(data: Buffer): Promise<void>
	remove(): Promise<void>
}

export function errorCode(error: unknown): string {
	return error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : "unknown"
}

// An error that logs as `code` through errorCode: for failures main raises itself, whose reason is the message.
export function codedError(code: string): Error {
	return Object.assign(new Error(code), { code })
}

// Owner-only. The file is written to a sibling and renamed over the old one, so a crash mid-write never leaves half a
// file. Writers must not overlap: they share the sibling.
export function atomicFile(file: string): AtomicFile {
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

			await rename(temp, file)
		},
		remove: () => rm(file, { force: true })
	}
}
