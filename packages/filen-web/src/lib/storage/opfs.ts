// OPFS helpers shared by the main thread and the workers; import-free so either side can take them.

// Walks (creating as needed, unless `create` is false) from the OPFS root down through the given directory segments.
export async function opfsDirectory(segments: readonly string[], create = true): Promise<FileSystemDirectoryHandle> {
	let dir = await navigator.storage.getDirectory()

	for (const segment of segments) {
		dir = await dir.getDirectoryHandle(segment, { create })
	}

	return dir
}

interface Walk {
	create: boolean
	handle: Promise<FileSystemDirectoryHandle>
}

const walkedDirectories = new Map<string, Walk>()

// opfsDirectory memoized per realm, so a hot path skips the root walk. A memoized handle whose directory was
// removed since (logout wipe, cleared site data) throws NotFoundError; callers then forget it so the next
// call walks (and re-creates, unless `create` is false) afresh. A walk that fails isn't kept. A walk that may not
// create never answers a caller that may: a directory it finds missing is created for that caller.
export function cachedOpfsDirectory(segments: readonly string[], create = true): Promise<FileSystemDirectoryHandle> {
	const key = segments.join("/")
	const memo = walkedDirectories.get(key)

	if (memo !== undefined) {
		if (!create || memo.create) {
			return memo.handle
		}

		return memo.handle.catch((e: unknown) => {
			if (!isNotFoundError(e)) {
				throw e
			}

			return cachedOpfsDirectory(segments, true)
		})
	}

	const walk: Walk = { create, handle: opfsDirectory(segments, create) }

	walkedDirectories.set(key, walk)

	void walk.handle.catch(() => {
		if (walkedDirectories.get(key) === walk) {
			walkedDirectories.delete(key)
		}
	})

	return walk.handle
}

export function forgetOpfsDirectory(segments: readonly string[]): void {
	walkedDirectories.delete(segments.join("/"))
}

export function isNotFoundError(e: unknown): boolean {
	return e instanceof DOMException && e.name === "NotFoundError"
}

// Sync access handles are exclusive: another context holding one makes createSyncAccessHandle throw this.
export function isLockConflictError(e: unknown): boolean {
	return e instanceof DOMException && e.name === "NoModificationAllowedError"
}

// A flat OPFS directory of small files named `<key><ext>`, with the directory segments it lives under.
export interface OpfsBlobStore {
	dir: readonly string[]
	ext: string
	// False for a store a logout wipe must stay gone from: a write landing in its directory after the directory was
	// removed is dropped instead of re-creating it, and no read, delete or sweep creates it.
	recreateWhenRemoved?: boolean
}

// How many entries of one directory are sized at once: enough to overlap the getFile round trips, few enough to
// keep the File objects alive at a time negligible.
const SIZE_BATCH = 64

// An entry removed while the walk runs (an eviction sweep, a wipe) counts as nothing.
function zeroIfGone(e: unknown): number {
	if (isNotFoundError(e)) {
		return 0
	}

	throw e
}

// Bytes of every file under `directory`, summed as it walks: no entry list is kept, nothing is read and nothing is
// created. An aborted signal stops the walk with its reason.
export async function directoryBytes(directory: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<number> {
	let bytes = 0
	let batch: Promise<number>[] = []

	for await (const entry of directory.values()) {
		signal?.throwIfAborted()
		batch.push(
			entry.kind === "file" ? entry.getFile().then(file => file.size, zeroIfGone) : directoryBytes(entry, signal).catch(zeroIfGone)
		)

		if (batch.length >= SIZE_BATCH) {
			bytes += (await Promise.all(batch)).reduce((sum, size) => sum + size, 0)
			batch = []
		}
	}

	return bytes + (await Promise.all(batch)).reduce((sum, size) => sum + size, 0)
}

// directoryBytes of the tree at `segments`, 0 when it does not exist. Never creates it.
export async function opfsTreeBytes(segments: readonly string[], signal?: AbortSignal): Promise<number> {
	let directory: FileSystemDirectoryHandle

	try {
		directory = await opfsDirectory(segments, false)
	} catch (e) {
		if (isNotFoundError(e)) {
			return 0
		}

		throw e
	}

	return directoryBytes(directory, signal)
}
