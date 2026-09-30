// OPFS helpers shared by the main thread and the workers; import-free so either side can take them.

// Walks (creating as needed) from the OPFS root down through the given directory segments.
export async function opfsDirectory(segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
	let dir = await navigator.storage.getDirectory()

	for (const segment of segments) {
		dir = await dir.getDirectoryHandle(segment, { create: true })
	}

	return dir
}

const walkedDirectories = new Map<string, Promise<FileSystemDirectoryHandle>>()

// opfsDirectory memoized per realm, so a hot path skips the root walk. A memoized handle whose directory was
// removed since (logout wipe, cleared site data) throws NotFoundError; callers then forget it so the next
// call walks (and re-creates) afresh.
export function cachedOpfsDirectory(segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
	const key = segments.join("/")
	const memo = walkedDirectories.get(key)

	if (memo !== undefined) {
		return memo
	}

	const walk = opfsDirectory(segments)

	walkedDirectories.set(key, walk)

	void walk.catch(() => {
		if (walkedDirectories.get(key) === walk) {
			walkedDirectories.delete(key)
		}
	})

	return walk
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
