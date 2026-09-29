import { THUMB_DIR, THUMB_DIR_ROOT, THUMB_EXT } from "@/features/drive/lib/thumbnails.logic"
import { isNotFoundError, opfsDirectory } from "@/lib/storage/opfs"

// Main-thread read side of the OPFS thumbnail store — async only (no createSyncAccessHandle, which
// is dedicated-worker-only by spec; see workers/thumbStore.ts for the worker-side write path over
// the same tree).

// A cache miss (never written, or evicted) resolves null rather than rejecting — the service's own
// generate-on-miss path treats this as the normal "not cached yet" signal, not an error.
export async function readThumbnailBlob(uuid: string): Promise<Blob | null> {
	try {
		const dir = await opfsDirectory(THUMB_DIR)
		const fileHandle = await dir.getFileHandle(`${uuid}${THUMB_EXT}`)

		return await fileHandle.getFile()
	} catch (e) {
		if (isNotFoundError(e)) {
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
		const dir = await opfsDirectory(THUMB_DIR)
		await dir.removeEntry(`${uuid}${THUMB_EXT}`)
	} catch (e) {
		if (isNotFoundError(e)) {
			return
		}

		throw e
	}
}

// Logout: the whole thumbnail tree, every cache generation included — decrypted derivatives of the
// account's files. Swept TWICE, like kvClear: a thumbnail write already in flight when the wipe starts
// (a generation past its last abort point) can hold a file open through the first removal, or land just
// after it and recreate the tree. Only a failure of the final pass is reported.
export async function wipeThumbnailStore(root: Promise<FileSystemDirectoryHandle> = navigator.storage.getDirectory()): Promise<void> {
	const parentSegments = THUMB_DIR_ROOT.slice(0, -1)
	const leaf = THUMB_DIR_ROOT.at(-1)

	if (leaf === undefined) {
		return
	}

	let failure: { reason: unknown } | null = null

	for (let pass = 0; pass < 2; pass++) {
		failure = null

		try {
			let dir = await root

			for (const segment of parentSegments) {
				dir = await dir.getDirectoryHandle(segment)
			}

			await dir.removeEntry(leaf, { recursive: true })
		} catch (e) {
			if (!isNotFoundError(e)) {
				failure = { reason: e }
			}
		}
	}

	if (failure !== null) {
		throw failure.reason
	}
}
