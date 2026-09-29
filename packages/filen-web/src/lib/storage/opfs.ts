// OPFS helpers shared by the main thread and the workers; import-free so either side can take them.

// Walks (creating as needed) from the OPFS root down through the given directory segments.
export async function opfsDirectory(segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
	let dir = await navigator.storage.getDirectory()

	for (const segment of segments) {
		dir = await dir.getDirectoryHandle(segment, { create: true })
	}

	return dir
}

export function isNotFoundError(e: unknown): boolean {
	return e instanceof DOMException && e.name === "NotFoundError"
}

// Sync access handles are exclusive: another context holding one makes createSyncAccessHandle throw this.
export function isLockConflictError(e: unknown): boolean {
	return e instanceof DOMException && e.name === "NoModificationAllowedError"
}
