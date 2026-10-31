import { lstat, readdir, readFile, rename } from "node:fs/promises"
import path from "node:path"
import { errorCode } from "../atomicFile.ts"

// The old client's sync state directory (userData/sync). Its pair list lives elsewhere (the old origin's storage) and
// is never touched. Once the import has read what it needs, the directory is renamed to sync.migrated-<date> and kept
// for good: an old client run again then finds no state and starts over by merging, instead of replaying deletions
// this engine held from stale snapshots.

const STATE_DIR = "sync"
const RETIRED_PREFIX = "sync.migrated-"

// The old directory under its name, then the retired ones, newest first.
async function stateDirectories(userData: string): Promise<string[]> {
	let retired: string[] = []

	try {
		retired = (await readdir(userData)).filter(name => name.startsWith(RETIRED_PREFIX)).sort((a, b) => b.localeCompare(a))
	} catch {
		// No userData yet: nothing retired.
	}

	return [STATE_DIR, ...retired].map(name => path.join(userData, name))
}

// The old client's ignore file of one of its pairs (ignorer/v1/<uuid>/filenIgnore), wherever the state directory is
// now; null when there is none or it is no UTF-8 text.
export async function readLegacyIgnorer(userData: string, uuid: string, warn: (message: string) => void): Promise<string | null> {
	for (const directory of await stateDirectories(userData)) {
		try {
			const bytes = await readFile(path.join(directory, "ignorer", "v1", uuid, "filenIgnore"))

			return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				warn(`sync: a pair's old ignore file was not read: ${errorCode(error)}`)

				return null
			}
		}
	}

	return null
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target)

		return true
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return false
		}

		throw error
	}
}

// Renames userData/sync to sync.migrated-<UTC date> (with -2, -3, … when that name is taken). "absent" when there is
// nothing to rename (a fresh install, or renamed already). A failure (a file held open on Windows: EBUSY, EPERM)
// throws, to be tried again on the next start.
export async function retireLegacySyncState(userData: string, now: number): Promise<{ renamedTo: string } | "absent"> {
	const source = path.join(userData, STATE_DIR)

	if (!(await exists(source))) {
		return "absent"
	}

	const base = `${RETIRED_PREFIX}${new Date(now).toISOString().slice(0, 10)}`
	let name = base

	for (let suffix = 2; await exists(path.join(userData, name)); suffix++) {
		name = `${base}-${String(suffix)}`
	}

	await rename(source, path.join(userData, name))

	return { renamedTo: name }
}
