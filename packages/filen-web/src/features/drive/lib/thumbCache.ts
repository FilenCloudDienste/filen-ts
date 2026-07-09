import { THUMB_DIR, THUMB_EXT } from "@/features/drive/lib/thumbnails.logic"

// Main-thread read side of the OPFS thumbnail store — async only (no createSyncAccessHandle, which
// is dedicated-worker-only by spec; see workers/thumb-store.ts for the worker-side write path over
// the same tree). Deliberately its own small directory-walk rather than importing thumb-store.ts:
// that module is worker-only in intent, and this one runs on the main thread — duplicating four
// lines keeps the two from becoming accidentally coupled.
async function thumbDirHandle(): Promise<FileSystemDirectoryHandle> {
	let dir = await navigator.storage.getDirectory()

	for (const segment of THUMB_DIR) {
		dir = await dir.getDirectoryHandle(segment, { create: true })
	}

	return dir
}

// A cache miss (never written, or evicted) resolves null rather than rejecting — the service's own
// generate-on-miss path treats this as the normal "not cached yet" signal, not an error.
export async function readThumbnailBlob(uuid: string): Promise<Blob | null> {
	try {
		const dir = await thumbDirHandle()
		const fileHandle = await dir.getFileHandle(`${uuid}${THUMB_EXT}`)

		return await fileHandle.getFile()
	} catch (e) {
		if (e instanceof DOMException && e.name === "NotFoundError") {
			return null
		}

		throw e
	}
}

// Called from the main thread directly (no worker round trip needed — removeEntry needs no
// exclusive lock) by the service's invalidateThumbnail, after a uuid rotation or a failed render
// that should allow a fresh regenerate. A missing entry is a clean no-op.
export async function deleteThumbnail(uuid: string): Promise<void> {
	try {
		const dir = await thumbDirHandle()
		await dir.removeEntry(`${uuid}${THUMB_EXT}`)
	} catch (e) {
		if (e instanceof DOMException && e.name === "NotFoundError") {
			return
		}

		throw e
	}
}
