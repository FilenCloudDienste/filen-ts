/// <reference lib="webworker" />
import { log } from "@/lib/log"
import {
	cachedOpfsDirectory,
	forgetOpfsDirectory,
	isLockConflictError,
	isNotFoundError,
	opfsDirectory,
	type OpfsBlobStore
} from "@/lib/storage/opfs"
import { planSizeCapEviction, Semaphore } from "@filen/shared"
import {
	THUMB_DIR,
	THUMB_DIR_ROOT,
	THUMB_GENERATION,
	THUMB_EXT,
	type ThumbCacheEntry,
	type ThumbnailCopy
} from "@/features/drive/lib/thumbnails.logic"

// Worker-only OPFS blob stores for cached images: drive thumbnails, and any other store of small
// derived images that passes its own directory, extension and cap — no wasm import anywhere in this
// module, so it stays trivially importable from sdk.worker.ts without dragging the SDK's own
// init/thread-pool concerns along. createSyncAccessHandle is dedicated-worker-only by spec; this module
// is never imported main-thread (see lib/storage/opfsBlobStore.ts for the async read side).

export const DRIVE_THUMB_STORE: OpfsBlobStore = { dir: THUMB_DIR, ext: THUMB_EXT }

// Persists one entry's bytes, keyed by the uuid of the file it derives from (plus whatever the store
// adds) — uuid rotates on any content change, so this is a plain overwrite-or-create with no versioning
// concern of its own. A second tab (or a second in-worker caller) already holding this exact file's sync
// access handle makes createSyncAccessHandle throw NoModificationAllowedError (proven live,
// cross-context) — caught here and skipped: the caller's own bytes still render, there is simply
// nothing new to persist this turn. Anything else that fails after the handle is acquired
// (write/flush/quota) propagates, so the caller's own defensive wrapping (see sdk.worker.ts's
// makeThumbnail/storeThumbnail) logs it once.
export async function writeStoreEntry(store: OpfsBlobStore, key: string, bytes: Uint8Array): Promise<void> {
	const name = `${key}${store.ext}`
	let fileHandle: FileSystemFileHandle

	try {
		fileHandle = await (await cachedOpfsDirectory(store.dir)).getFileHandle(name, { create: true })
	} catch (e) {
		if (!isNotFoundError(e)) {
			throw e
		}

		// The memoized directory was removed since (logout wipe, cleared site data). A store that must stay wiped
		// keeps the stale handle, so every later write of the session is dropped too.
		if (store.recreateWhenRemoved === false) {
			log.info("thumb-store", "writeStoreEntry: store directory removed, skipping persist", key)

			return
		}

		// Any other walks again, re-creating it.
		forgetOpfsDirectory(store.dir)
		fileHandle = await (await cachedOpfsDirectory(store.dir)).getFileHandle(name, { create: true })
	}

	let handle: FileSystemSyncAccessHandle

	try {
		handle = await fileHandle.createSyncAccessHandle()
	} catch (e) {
		// The benign case: another tab/worker holds the handle for the same uuid (sync access handles
		// are exclusive) — its write persists the identical bytes, so skipping is lossless. Anything
		// else (quota, permissions) is unexpected and logged louder, but still skip-not-throw: the
		// caller's in-hand bytes render either way and persistence stays best-effort.
		if (isLockConflictError(e)) {
			log.info("thumb-store", "writeStoreEntry: concurrent writer holds the handle, skipping persist", key)
		} else {
			log.warn("thumb-store", "writeStoreEntry: sync access handle unavailable, skipping persist", key, e)
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

export function writeThumb(uuid: string, bytes: Uint8Array): Promise<void> {
	return writeStoreEntry(DRIVE_THUMB_STORE, uuid, bytes)
}

// How many thumbnail copies run at once in this worker: a copy job hands its files over in batches,
// and this bounds the OPFS files open for them however large the job.
const copyGate = new Semaphore(4)

async function copyThumb(dir: FileSystemDirectoryHandle, copy: ThumbnailCopy): Promise<void> {
	let source: Blob

	try {
		source = await (await dir.getFileHandle(`${copy.from}${THUMB_EXT}`)).getFile()
	} catch (e) {
		if (isNotFoundError(e)) {
			return
		}

		throw e
	}

	if (source.size > 0) {
		await writeThumb(copy.to, new Uint8Array(await source.arrayBuffer()))
	}
}

// Gives each copy's `to` the bytes cached under its `from`, read and written here so they never cross
// to the page. A copy with nothing cached to give is left alone. A miss keeps the memoized directory, unlike the page's own read: most sources in a copy miss, and a walk
// per miss would cost more than the lookups, while a directory removed meanwhile only makes every
// lookup a miss, which is right for an emptied cache.
export async function copyThumbs(copies: readonly ThumbnailCopy[]): Promise<void> {
	if (copies.length === 0) {
		return
	}

	const dir = await cachedOpfsDirectory(THUMB_DIR)

	await Promise.all(
		copies.map(copy =>
			copyGate.withPermit(async () => {
				try {
					await copyThumb(dir, copy)
				} catch (e) {
					log.warn("thumb-store", "copyThumbs: copy failed", copy.from, copy.to, e)
				}
			})
		)
	)
}

// A store that must stay wiped is reached through the session's memoized handle, which keeps failing once a wipe
// removed its directory, and is never created here; one only a write creates is walked afresh without creating it;
// any other is walked (and created) afresh.
function storeDirectory(store: OpfsBlobStore): Promise<FileSystemDirectoryHandle> {
	if (store.recreateWhenRemoved === false) {
		return cachedOpfsDirectory(store.dir, false)
	}

	return opfsDirectory(store.dir, store.createOnWriteOnly !== true)
}

// Enumerates every entry of a store with its on-disk size and last-write time — sweepStore's own
// input. getFile() per entry (not getSize() via a sync access handle) so this stays a plain async
// read, safely callable even while another entry in the same directory is mid-write elsewhere. A
// removed directory has none.
export async function listStoreEntries(store: OpfsBlobStore): Promise<ThumbCacheEntry[]> {
	const entries: ThumbCacheEntry[] = []

	try {
		const dir = await storeDirectory(store)

		for await (const handle of dir.values()) {
			if (handle.kind !== "file") {
				continue
			}

			const file = await handle.getFile()
			entries.push({ name: handle.name, size: file.size, lastModified: file.lastModified })
		}
	} catch (e) {
		if (!isNotFoundError(e)) {
			throw e
		}
	}

	return entries
}

export function listThumbs(): Promise<ThumbCacheEntry[]> {
	return listStoreEntries(DRIVE_THUMB_STORE)
}

// Evicts every generation directory under THUMB_DIR_ROOT other than the live THUMB_GENERATION — a
// stale "v1" tree (the old 512px cache) never serves and never sits around consuming quota once this
// has run. Called once per worker session alongside sweepThumbs (see sdk.worker.ts's
// armThumbSweep), fire-and-forget: this is a housekeeping pass, not something a thumbnail request
// should ever wait on. Per-entry failures are logged and skipped, same rationale as sweepThumbs'
// eviction loop below — one locked directory must not strand every other stale generation.
export async function removeStaleThumbGenerations(): Promise<void> {
	const dir = await opfsDirectory(THUMB_DIR_ROOT)

	for await (const handle of dir.values()) {
		if (handle.kind !== "directory" || handle.name === THUMB_GENERATION) {
			continue
		}

		try {
			await dir.removeEntry(handle.name, { recursive: true })
		} catch (e) {
			log.warn("thumb-store", "removeStaleThumbGenerations: evict failed", handle.name, e)
		}
	}
}

// Oldest-first cap enforcement — called once per worker session and again every so many writes (see
// storeCapSweeper) so a long-lived tab's cache never grows unbounded. Per-entry eviction failures are
// logged and skipped rather than aborting the whole sweep: one locked file (another tab mid-write) must
// not leave every OTHER oversize entry stranded.
export async function sweepStore(store: OpfsBlobStore, capBytes: number): Promise<void> {
	const entries = await listStoreEntries(store)
	const evict = planSizeCapEviction(
		entries.map(entry => ({ id: entry.name, size: entry.size, timestamp: entry.lastModified })),
		capBytes,
		{ protectNewest: false }
	)

	if (evict.length === 0) {
		return
	}

	const dir = await storeDirectory(store)

	await Promise.all(
		evict.map(async name => {
			try {
				await dir.removeEntry(name)
			} catch (e) {
				log.warn("thumb-store", "sweepStore: evict failed", name, e)
			}
		})
	)
}

export function sweepThumbs(capBytes: number): Promise<void> {
	return sweepStore(DRIVE_THUMB_STORE, capBytes)
}

export interface StoreCapSweeper {
	// Called on every write path, and on paths that settle without writing: the first call of a worker
	// session sweeps (and runs `onFirstArm`).
	arm(): void
	// Counts writes; every `writesPerSweep` of them sweep again.
	noteWrites(count: number): void
}

// Keeps a store under its cap for the worker's lifetime: once at the first use of a session, then again
// every `writesPerSweep` writes, never two sweeps at once. Fire-and-forget: eviction is housekeeping,
// never something a write should wait on.
export function storeCapSweeper(store: OpfsBlobStore, capBytes: number, writesPerSweep: number, onFirstArm?: () => void): StoreCapSweeper {
	let armed = false
	let writesSinceSweep = 0
	let running = false

	const sweep = (): void => {
		if (running) {
			return
		}

		running = true
		writesSinceSweep = 0

		void sweepStore(store, capBytes)
			.catch((e: unknown) => {
				log.warn("thumb-store", "sweepStore failed", store.dir.join("/"), e)
			})
			.finally(() => {
				running = false
			})
	}

	return {
		arm: () => {
			if (armed) {
				return
			}

			armed = true
			onFirstArm?.()
			sweep()
		},
		noteWrites: count => {
			writesSinceSweep += count

			if (writesSinceSweep >= writesPerSweep) {
				sweep()
			}
		}
	}
}
