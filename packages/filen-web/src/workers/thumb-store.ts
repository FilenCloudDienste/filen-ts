/// <reference lib="webworker" />
import { log } from "@/lib/log"
import { THUMB_DIR, THUMB_EXT, pickEvictions, type ThumbCacheEntry } from "@/lib/drive/thumbnails.logic"

// Worker-only OPFS blob store for cached thumbnails — no wasm import anywhere in this module, so it
// stays trivially importable from sdk.worker.ts without dragging the SDK's own init/thread-pool
// concerns along. createSyncAccessHandle is dedicated-worker-only by spec; this module is never
// imported main-thread (see thumb-cache.ts for the async main-thread read side over the same tree).
async function thumbDirHandle(): Promise<FileSystemDirectoryHandle> {
	let dir = await navigator.storage.getDirectory()

	for (const segment of THUMB_DIR) {
		dir = await dir.getDirectoryHandle(segment, { create: true })
	}

	return dir
}

// Persists one thumbnail's bytes, keyed by the item's own uuid — uuid rotates on any content change,
// so this is a plain overwrite-or-create with no versioning concern of its own. A second tab (or a
// second in-worker caller) already holding this exact file's sync access handle makes
// createSyncAccessHandle throw NoModificationAllowedError (proven live, cross-context) — caught here
// and skipped: the caller's own bytes still render, there is simply nothing new to persist this turn.
// Anything else that fails after the handle is acquired (write/flush/quota) propagates, so the
// caller's own defensive wrapping (see sdk.worker.ts's makeThumbnail/storeThumbnail) logs it once.
export async function writeThumb(uuid: string, bytes: Uint8Array): Promise<void> {
	const dir = await thumbDirHandle()
	const fileHandle = await dir.getFileHandle(`${uuid}${THUMB_EXT}`, { create: true })

	let handle: FileSystemSyncAccessHandle

	try {
		handle = await fileHandle.createSyncAccessHandle()
	} catch (e) {
		// The benign case: another tab/worker holds the handle for the same uuid (sync access handles
		// are exclusive) — its write persists the identical bytes, so skipping is lossless. Anything
		// else (quota, permissions) is unexpected and logged louder, but still skip-not-throw: the
		// caller's in-hand bytes render either way and persistence stays best-effort.
		if (e instanceof DOMException && e.name === "NoModificationAllowedError") {
			log.info("thumb-store", "writeThumb: concurrent writer holds the handle, skipping persist", uuid)
		} else {
			log.warn("thumb-store", "writeThumb: sync access handle unavailable, skipping persist", uuid, e)
		}
		return
	}

	try {
		handle.truncate(0)
		handle.write(bytes, { at: 0 })
		handle.flush()
	} finally {
		handle.close()
	}
}

// A missing entry is a clean no-op, not a failure — invalidateThumbnail/sweepThumbs both call this
// against a uuid that may already be gone (a re-invalidate, a file evicted by a concurrent sweep).
export async function deleteThumb(uuid: string): Promise<void> {
	const dir = await thumbDirHandle()

	try {
		await dir.removeEntry(`${uuid}${THUMB_EXT}`)
	} catch (e) {
		if (e instanceof DOMException && e.name === "NotFoundError") {
			return
		}

		throw e
	}
}

// Enumerates every cached thumbnail with its on-disk size and last-write time — sweepThumbs' own
// input. getFile() per entry (not getSize() via a sync access handle) so this stays a plain async
// read, safely callable even while another entry in the same directory is mid-write elsewhere.
export async function listThumbs(): Promise<ThumbCacheEntry[]> {
	const dir = await thumbDirHandle()
	const entries: ThumbCacheEntry[] = []

	for await (const handle of dir.values()) {
		if (handle.kind !== "file") {
			continue
		}

		const file = await handle.getFile()
		entries.push({ name: handle.name, size: file.size, lastModified: file.lastModified })
	}

	return entries
}

// Oldest-first cap enforcement — called once per worker session (see sdk.worker.ts's own once-flag)
// so a long-lived tab's cache never grows unbounded. Per-entry eviction failures are logged and
// skipped rather than aborting the whole sweep: one locked file (another tab mid-write) must not
// leave every OTHER oversize entry stranded.
export async function sweepThumbs(capBytes: number): Promise<void> {
	const entries = await listThumbs()
	const evict = pickEvictions(entries, capBytes)

	if (evict.length === 0) {
		return
	}

	const dir = await thumbDirHandle()

	await Promise.all(
		evict.map(async name => {
			try {
				await dir.removeEntry(name)
			} catch (e) {
				log.warn("thumb-store", "sweepThumbs: evict failed", name, e)
			}
		})
	)
}
