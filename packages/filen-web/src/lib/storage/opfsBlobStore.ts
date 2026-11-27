import { cachedOpfsDirectory, forgetOpfsDirectory, isNotFoundError, type OpfsBlobStore } from "@/lib/storage/opfs"

// The async side of an OPFS blob store, usable on the main thread (writes need a sync access handle,
// which only a dedicated worker has: see workers/thumbStore.ts).

// Neither a read nor a delete creates a store that must stay wiped: in Chromium a handle is a path, so re-creating
// the directory would let a write still out in a worker through its pre-wipe handle. Nor one only a write creates.
function storeDirectory(store: OpfsBlobStore): Promise<FileSystemDirectoryHandle> {
	return cachedOpfsDirectory(store.dir, store.recreateWhenRemoved !== false && store.createOnWriteOnly !== true)
}

// A miss (never written, or evicted) resolves null. A NotFoundError may also mean the memoized directory
// itself is gone (or was never created), which implies the file is too; forgetting it makes the next call walk
// afresh.
export async function readStoreBlob(store: OpfsBlobStore, key: string): Promise<Blob | null> {
	try {
		const dir = await storeDirectory(store)
		const fileHandle = await dir.getFileHandle(`${key}${store.ext}`)

		return await fileHandle.getFile()
	} catch (e) {
		if (isNotFoundError(e)) {
			forgetOpfsDirectory(store.dir)

			return null
		}

		throw e
	}
}

// removeEntry needs no exclusive lock, so this runs anywhere. A missing entry is a clean no-op.
export async function deleteStoreEntry(store: OpfsBlobStore, key: string): Promise<void> {
	try {
		const dir = await storeDirectory(store)

		await dir.removeEntry(`${key}${store.ext}`)
	} catch (e) {
		if (isNotFoundError(e)) {
			forgetOpfsDirectory(store.dir)

			return
		}

		throw e
	}
}

// Removes the tree at `rootSegments` with everything under it. Swept TWICE, like kvClear: a write already
// in flight when the wipe starts can hold a file open through the first removal, or land just after it
// and recreate the tree. Only a failure of the final pass is reported. `memoized` are the directories
// under it whose walks this realm may have memoized.
export async function wipeOpfsTree(
	rootSegments: readonly string[],
	memoized: readonly (readonly string[])[],
	root: Promise<FileSystemDirectoryHandle> = navigator.storage.getDirectory()
): Promise<void> {
	const parentSegments = rootSegments.slice(0, -1)
	const leaf = rootSegments.at(-1)

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

	for (const segments of memoized) {
		forgetOpfsDirectory(segments)
	}

	if (failure !== null) {
		throw failure.reason
	}
}
