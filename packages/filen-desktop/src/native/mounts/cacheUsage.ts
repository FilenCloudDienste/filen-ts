import { lstat, readdir, statfs } from "node:fs/promises"
import path from "node:path"

function clamp(value: number): number {
	return Math.min(Math.max(0, Math.floor(value)), Number.MAX_SAFE_INTEGER)
}

function missing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code

	return code === "ENOENT" || code === "ENOTDIR"
}

// The bytes the files below `dir` take, one directory at a time; a missing directory holds none.
async function usedBytes(dir: string): Promise<number> {
	let entries

	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch (error) {
		if (missing(error)) {
			return 0
		}

		throw error
	}

	let total = 0

	for (const entry of entries) {
		const child = path.join(dir, entry.name)

		if (entry.isDirectory()) {
			total += await usedBytes(child)
		} else if (entry.isFile()) {
			total += await lstat(child).then(
				stats => stats.size,
				(error: unknown) => {
					if (missing(error)) {
						return 0
					}

					throw error
				}
			)
		}
	}

	return total
}

// The space free to this user on the volume `dir` is on (or would be on, while it does not exist yet).
async function freeBytes(dir: string): Promise<number> {
	for (let current = dir; ; current = path.dirname(current)) {
		try {
			const stats = await statfs(current)

			return stats.bavail * stats.bsize
		} catch (error) {
			if (!missing(error) || path.dirname(current) === current) {
				throw error
			}
		}
	}
}

// What the user's rclone cache holds and what its volume has left.
export async function cacheUsage(dir: string): Promise<{ usedBytes: number; freeBytes: number }> {
	const [used, free] = await Promise.all([usedBytes(dir), freeBytes(dir)])

	return { usedBytes: clamp(used), freeBytes: clamp(free) }
}
