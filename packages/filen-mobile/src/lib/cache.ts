import {
	AnyNormalDir,
	AnyDirWithContext,
	type AnySharedDirWithContext,
	type File,
	type AnyLinkedDir,
	type DirPublicLink,
	type Dir
} from "@filen/sdk-rs"
import { type DriveItem, type Note, type Chat } from "@/types"
import sqlite, { prefixUpperBound } from "@/lib/sqlite"
import { serialize, deserialize } from "@/lib/serializer"
import { AppState } from "react-native"

// Critical: When changing anything related to storage index/store/persistence format, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 1
export const GLOBAL_PREFIX = `cache:v${VERSION}`

const PERSIST_DEBOUNCE = 1000
const PERSIST_CHUNK_SIZE = 100

type Mutation =
	| {
			type: "set"
			entryKey: string
	  }
	| {
			type: "delete"
			entryKey: string
	  }
	| {
			type: "clear"
	  }

/**
 * Map subclass that reports individual mutations (set/delete/clear) to the cache
 * so only changed entries are persisted to SQLite instead of the entire map.
 */
export class PersistentMap<V> extends Map<string, V> {
	private readonly onMutate: (mutation: Mutation) => void
	public ready: boolean = false

	public constructor(onMutate: (mutation: Mutation) => void) {
		super()

		this.onMutate = onMutate
	}

	private assertReady(): void {
		if (!this.ready) {
			throw new Error("Cache not restored yet — call cache.restore() before writing")
		}
	}

	public override set(key: string, value: V): this {
		this.assertReady()

		if (super.get(key) === value) {
			return this
		}

		super.set(key, value)

		this.onMutate({
			type: "set",
			entryKey: key
		})

		return this
	}

	public override delete(key: string): boolean {
		this.assertReady()

		const result = super.delete(key)

		if (result) {
			this.onMutate({
				type: "delete",
				entryKey: key
			})
		}

		return result
	}

	public override clear(): void {
		this.assertReady()

		if (this.size > 0) {
			super.clear()

			this.onMutate({
				type: "clear"
			})
		}
	}
}

type MapEntry = {
	key: string
	map: PersistentMap<unknown>
}

// Snapshot of the three dirty sets taken by drainDirty(). Kept around for the lifetime of
// a persist attempt so a failed batch can re-mark exactly what it drained.
type DrainedDirty = {
	clears: Set<string>
	deletes: Map<string, Set<string>>
	upserts: Map<string, Set<string>>
}

/**
 * Value shape for `cameraUploadHashes`. `md5` is the hash of the asset content as it
 * was last uploaded (or last verified against the cache); `verifiedModificationTime`
 * is the asset's modificationTime at the moment that md5 was last verified, letting
 * camera upload skip re-hashing (and re-downloading iCloud-offloaded assets) when the
 * mtime is unchanged. `-1` means "never verified" and always forces one hash.
 *
 * Entries persisted before this shape existed are plain md5 strings — readers treat a
 * string value as `{ md5: <string>, verifiedModificationTime: -1 }` and upgrade it in
 * place on the next write (lazy migration; no version bump / cache wipe needed).
 */
export type CameraUploadHashEntry = {
	md5: string
	verifiedModificationTime: number
}

export class Cache {
	private readonly registry: MapEntry[] = []
	private readonly dirtyUpserts = new Map<string, Set<string>>()
	private readonly dirtyDeletes = new Map<string, Set<string>>()
	private readonly dirtyClears = new Set<string>()

	// Not persisted — in-memory only, cleared on app restart
	public rootUuid: string | null = null

	// Not persisted — managed separately by secureStore.ts with its own encryption
	public readonly secureStore = new Map<string, unknown>()

	// Persisted — each entry independently persisted to SQLite KV
	public readonly directoryUuidToName: PersistentMap<string>
	public readonly noteUuidToNote: PersistentMap<Note>
	public readonly chatUuidToChat: PersistentMap<Chat>
	public readonly uuidToAnyDriveItem: PersistentMap<DriveItem>
	public readonly fileUuidToNormalFile: PersistentMap<File>
	public readonly directoryUuidToAnySharedDirWithContext: PersistentMap<AnySharedDirWithContext>
	public readonly directoryUuidToAnyNormalDir: PersistentMap<AnyNormalDir>
	public readonly directoryUuidToAnyDirWithContext: PersistentMap<AnyDirWithContext>
	public readonly availableThumbnails: PersistentMap<boolean>
	// The string arm of the union is the LEGACY persisted shape (bare md5) — see
	// CameraUploadHashEntry. Writers must always write the object shape.
	public readonly cameraUploadHashes: PersistentMap<CameraUploadHashEntry | string>
	public readonly chatAttachmentLayouts: PersistentMap<{
		width: number
		height: number
	}>
	public readonly directoryUuidToAnyLinkedDirWithMeta: PersistentMap<{
		dir: AnyLinkedDir
		meta: DirPublicLink
	}>

	public constructor() {
		this.directoryUuidToName = this.createMap<string>("directoryUuidToName")
		this.noteUuidToNote = this.createMap<Note>("noteUuidToNote")
		this.chatUuidToChat = this.createMap<Chat>("chatUuidToChat")
		this.uuidToAnyDriveItem = this.createMap<DriveItem>("uuidToAnyDriveItem")
		this.fileUuidToNormalFile = this.createMap<File>("fileUuidToNormalFile")
		this.directoryUuidToAnySharedDirWithContext = this.createMap<AnySharedDirWithContext>("directoryUuidToAnySharedDirWithContext")
		this.directoryUuidToAnyNormalDir = this.createMap<AnyNormalDir>("directoryUuidToAnyNormalDir")
		this.directoryUuidToAnyDirWithContext = this.createMap<AnyDirWithContext>("directoryUuidToAnyDirWithContext")
		this.availableThumbnails = this.createMap<boolean>("availableThumbnails")
		this.cameraUploadHashes = this.createMap<CameraUploadHashEntry | string>("cameraUploadHashes")
		this.chatAttachmentLayouts = this.createMap<{
			width: number
			height: number
		}>("chatAttachmentLayouts")
		this.directoryUuidToAnyLinkedDirWithMeta = this.createMap<{
			dir: AnyLinkedDir
			meta: DirPublicLink
		}>("directoryUuidToAnyLinkedDirWithMeta")

		AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				// flushNow() resolves only once the batch has actually landed (it never
				// rejects — failures re-mark their keys dirty internally), so the write is
				// in flight before the process can be suspended instead of fire-and-forget.
				void this.flushNow()
			}
		})
	}

	private createMap<V>(name: string): PersistentMap<V> {
		const key = `${GLOBAL_PREFIX}:${name}`

		const map = new PersistentMap<V>(mutation => {
			switch (mutation.type) {
				case "set": {
					let upserts = this.dirtyUpserts.get(key)

					if (!upserts) {
						upserts = new Set()

						this.dirtyUpserts.set(key, upserts)
					}

					upserts.add(mutation.entryKey)

					if (this.dirtyDeletes.size !== 0) {
						this.dirtyDeletes.get(key)?.delete(mutation.entryKey)
					}

					break
				}

				case "delete": {
					let deletes = this.dirtyDeletes.get(key)

					if (!deletes) {
						deletes = new Set()

						this.dirtyDeletes.set(key, deletes)
					}

					deletes.add(mutation.entryKey)

					if (this.dirtyUpserts.size !== 0) {
						this.dirtyUpserts.get(key)?.delete(mutation.entryKey)
					}

					break
				}

				case "clear": {
					this.dirtyClears.add(key)

					this.dirtyUpserts.delete(key)
					this.dirtyDeletes.delete(key)

					break
				}
			}

			this.persistDirty()
		})

		this.registry.push({
			key,
			map: map as PersistentMap<unknown>
		})

		return map
	}

	private persisting = false
	private clearGeneration = 0

	// Set by clear() (logout wipe) and reset by restore() (next authenticated session). While locked,
	// the persist paths refuse to write so a stray mutation, debounce, or AppState-background flush
	// during the logout window cannot re-INSERT decrypted metadata into the just-emptied plaintext kv.
	private locked = false

	// Serializes ALL SQLite persist work (sync flush + async chunked persist): one writer at a
	// time. Without this, a flushNow() landing during persistAsync's chunked build could commit
	// newer values first and then be overwritten when the older batch commits last (stale row
	// wins until the next mutation). The later writer drains the then-current dirty sets and
	// reads then-current map values, so the newest value always lands last.
	private writeChain: Promise<void> = Promise.resolve()

	private enqueueWrite(work: () => Promise<void>): Promise<void> {
		const next = this.writeChain.then(work)

		// Writers handle their own failures (re-marking their drained keys dirty), but never
		// let a rejection poison the chain for subsequent writers.
		this.writeChain = next.catch(() => {})

		return next
	}

	/**
	 * Snapshots and empties the three dirty sets. The snapshot shares the inner Sets by
	 * reference — safe because onMutate only mutates Sets reachable through the (now
	 * emptied) live maps, never a drained snapshot.
	 */
	private drainDirty(): DrainedDirty {
		const clears = new Set(this.dirtyClears)
		const deletes = new Map(this.dirtyDeletes)
		const upserts = new Map(this.dirtyUpserts)

		this.dirtyClears.clear()
		this.dirtyDeletes.clear()
		this.dirtyUpserts.clear()

		return {
			clears,
			deletes,
			upserts
		}
	}

	/**
	 * Builds the DELETE/INSERT command list for a drained snapshot synchronously, without
	 * any await or chunking. Used by the flush path; persistAsync keeps its own chunked
	 * build to preserve the setImmediate yields.
	 */
	private buildCommands({ clears, deletes, upserts }: DrainedDirty): [string, (string | Uint8Array)[]][] {
		const commands: [string, (string | Uint8Array)[]][] = []

		for (const mapKey of clears) {
			commands.push(["DELETE FROM kv WHERE key LIKE ?", [mapKey + ":%"]])
		}

		for (const [mapKey, entryKeys] of deletes) {
			for (const entryKey of entryKeys) {
				commands.push(["DELETE FROM kv WHERE key = ?", [mapKey + ":" + entryKey]])
			}
		}

		for (const entry of this.registry) {
			const upsertKeys = upserts.get(entry.key)

			if (!upsertKeys) {
				continue
			}

			for (const entryKey of upsertKeys) {
				const value = entry.map.get(entryKey)

				if (value !== undefined) {
					commands.push(["INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [entry.key + ":" + entryKey, serialize(value)]])
				}
			}
		}

		return commands
	}

	/**
	 * Re-marks the keys of a failed (never-landed) batch as dirty so the next persist
	 * retries them instead of silently dropping the drained mutations. Keys a NEWER
	 * mutation superseded since the drain (delete-over-upsert, upsert-over-delete,
	 * whole-map clear) are skipped so the retry cannot clobber fresher intent, and the
	 * whole re-mark is refused after a clear() bumped the generation — re-dirtying
	 * wiped logout data would leak it into the next session's first persist.
	 */
	private remarkFailedBatch(generation: number, { clears, deletes, upserts }: DrainedDirty): void {
		if (generation !== this.clearGeneration || this.locked) {
			return
		}

		// Dirt present right now arrived AFTER the drain — it is newer than the failed
		// batch and must win. Snapshot the newer clears BEFORE re-adding the drained ones.
		const newerClears = new Set(this.dirtyClears)

		for (const mapKey of clears) {
			// Replaying a drained clear is safe even with newer per-key dirt present:
			// buildCommands always executes clears before deletes/upserts.
			this.dirtyClears.add(mapKey)
		}

		for (const [mapKey, entryKeys] of deletes) {
			if (newerClears.has(mapKey)) {
				continue
			}

			let target = this.dirtyDeletes.get(mapKey)

			for (const entryKey of entryKeys) {
				if (this.dirtyUpserts.get(mapKey)?.has(entryKey)) {
					continue
				}

				if (!target) {
					target = new Set()

					this.dirtyDeletes.set(mapKey, target)
				}

				target.add(entryKey)
			}
		}

		for (const [mapKey, entryKeys] of upserts) {
			if (newerClears.has(mapKey)) {
				continue
			}

			let target = this.dirtyUpserts.get(mapKey)

			for (const entryKey of entryKeys) {
				if (this.dirtyDeletes.get(mapKey)?.has(entryKey)) {
					continue
				}

				if (!target) {
					target = new Set()

					this.dirtyUpserts.set(mapKey, target)
				}

				target.add(entryKey)
			}
		}
	}

	/**
	 * Serialized flush persist — used by flushNow() when the app backgrounds. Drains and
	 * builds in one go (no chunk yields) and resolves only once the batch has landed (or
	 * its keys were re-marked dirty after a failure). Never rejects.
	 */
	private persistNow(): Promise<void> {
		return this.enqueueWrite(async () => {
			if (this.locked) {
				return
			}

			if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0 && this.dirtyClears.size === 0) {
				return
			}

			const generation = this.clearGeneration
			const now = performance.now()
			const drained = this.drainDirty()

			try {
				const commands = this.buildCommands(drained)

				if (commands.length === 0) {
					return
				}

				console.log(`[Cache] Persisting ${commands.length} changes`)

				const db = await sqlite.openDb()

				// A clear() that lands between draining the dirty sets and opening the DB must win:
				// writing the just-drained commands would re-INSERT the wiped rows (logout leak).
				if (generation !== this.clearGeneration) {
					return
				}

				await db.executeBatch(commands)

				console.log(`[Cache] Persisted in ${(performance.now() - now).toFixed(2)}ms`)
			} catch (err) {
				console.error("[Cache] Failed to batch persist", err)

				// The batch never landed — re-mark the drained keys so the next persist retries.
				this.remarkFailedBatch(generation, drained)
			}
		})
	}

	/**
	 * Async persist — yields to the event loop every PERSIST_CHUNK_SIZE items
	 * so the JS thread stays responsive during large directory serialization.
	 */
	private async persistAsync(): Promise<void> {
		if (this.persisting) {
			return
		}

		this.persisting = true

		try {
			await this.enqueueWrite(() => this.persistAsyncWork())
		} finally {
			this.persisting = false

			if (!this.locked && (this.dirtyUpserts.size > 0 || this.dirtyDeletes.size > 0 || this.dirtyClears.size > 0)) {
				this.persistDirty()
			}
		}
	}

	private async persistAsyncWork(): Promise<void> {
		if (this.locked) {
			return
		}

		if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0 && this.dirtyClears.size === 0) {
			return
		}

		const generation = this.clearGeneration
		const now = performance.now()
		const drained = this.drainDirty()

		try {
			const commands: [string, (string | Uint8Array)[]][] = []

			for (const mapKey of drained.clears) {
				commands.push(["DELETE FROM kv WHERE key LIKE ?", [mapKey + ":%"]])
			}

			for (const [mapKey, entryKeys] of drained.deletes) {
				for (const entryKey of entryKeys) {
					commands.push(["DELETE FROM kv WHERE key = ?", [mapKey + ":" + entryKey]])
				}
			}

			let serialized = 0

			for (const entry of this.registry) {
				const upsertKeys = drained.upserts.get(entry.key)

				if (!upsertKeys) {
					continue
				}

				for (const entryKey of upsertKeys) {
					const value = entry.map.get(entryKey)

					if (value !== undefined) {
						commands.push([
							"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
							[entry.key + ":" + entryKey, serialize(value)]
						])

						serialized++

						if (serialized % PERSIST_CHUNK_SIZE === 0) {
							await new Promise<void>(resolve => {
								setImmediate(resolve)
							})
						}
					}
				}
			}

			if (commands.length === 0) {
				return
			}

			console.log(`[Cache] Persisting ${commands.length} changes`)

			const db = await sqlite.openDb()

			if (generation !== this.clearGeneration) {
				return
			}

			await db.executeBatch(commands)

			console.log(`[Cache] Persisted in ${(performance.now() - now).toFixed(2)}ms`)
		} catch (err) {
			console.error("[Cache] Failed to persist", err)

			// The batch never landed — re-mark the drained keys so the next persist retries.
			this.remarkFailedBatch(generation, drained)
		}
	}

	// Trailing-debounce scheduler with O(1) re-arms: a generic debounce clears and
	// re-creates a timer on EVERY call — two timer syscalls per cache mutation, ~60k
	// timer ops for one 10k-folder refetch. Here only the FIRST mutation of an idle
	// window arms a timer; later mutations just bump `lastMutationAt`. When the timer
	// fires early (mutations extended the window) it re-arms once for the remainder, so
	// the persist still runs exactly PERSIST_DEBOUNCE after the LAST mutation —
	// trailing-edge semantics identical to the previous implementation (pinned by the
	// hardening suite's window-extension test).
	private persistTimer: ReturnType<typeof setTimeout> | null = null
	private lastMutationAt = 0

	private readonly persistDirty: (() => void) & { cancel: () => void } = (() => {
		const onTimer = (): void => {
			this.persistTimer = null

			const elapsed = performance.now() - this.lastMutationAt

			if (elapsed < PERSIST_DEBOUNCE) {
				this.persistTimer = setTimeout(onTimer, PERSIST_DEBOUNCE - elapsed)

				return
			}

			this.persistAsync()
		}

		const trigger = (): void => {
			this.lastMutationAt = performance.now()

			if (this.persistTimer === null) {
				this.persistTimer = setTimeout(onTimer, PERSIST_DEBOUNCE)
			}
		}

		const fn = trigger as (() => void) & { cancel: () => void }

		fn.cancel = (): void => {
			if (this.persistTimer !== null) {
				clearTimeout(this.persistTimer)

				this.persistTimer = null
			}
		}

		return fn
	})()

	/**
	 * Populate maps from SQLite. Uses Map.prototype.set to bypass
	 * PersistentMap's onMutate and avoid a write-back cycle.
	 * Call during app setup before first render.
	 */
	public async restore(): Promise<void> {
		const now = performance.now()
		const rowCounts: string[] = []

		const db = await sqlite.openDb()

		const results = await Promise.allSettled(
			this.registry.map(async ({ key, map }) => {
				const prefix = key + ":"
				const prefixLength = prefix.length
				const rows = await db.executeRaw("SELECT key, value FROM kv WHERE key >= ? AND key < ?", [
					prefix,
					prefixUpperBound(prefix)
				])

				for (const row of rows) {
					const entryKey = (row[0] as string).slice(prefixLength)

					Map.prototype.set.call(map, entryKey, deserialize(row[1] as string))
				}

				rowCounts.push(`${key}=${rows.length}`)
			})
		)

		for (let i = 0; i < results.length; i++) {
			const result = results[i] as PromiseSettledResult<void>

			if (result.status === "rejected") {
				const { key } = this.registry[i] as MapEntry

				console.error(`[Cache] Failed to restore ${key}, clearing corrupted data`, result.reason)

				sqlite.kvAsync.removeByPrefix(key + ":").catch(removeErr => {
					console.error(`[Cache] Failed to remove corrupted keys for ${key}`, removeErr)
				})
			}
		}

		for (const { map } of this.registry) {
			map.ready = true
		}

		// A fresh authenticated session has hydrated — re-enable persistence after a prior logout lock.
		this.locked = false

		console.log(`[Cache] Restored in ${(performance.now() - now).toFixed(2)}ms (${rowCounts.join(", ")})`)
	}

	public flush(): void {
		this.persistDirty()
	}

	/**
	 * Cancels the pending debounce and persists every dirty entry immediately. The
	 * returned promise settles once the batch has landed on disk (or its keys were
	 * re-marked dirty after a failure) — the AppState background handler threads it so
	 * the write is not fire-and-forget while the process is being suspended. Never
	 * rejects, so callers that cannot await may safely ignore the promise.
	 */
	public flushNow(): Promise<void> {
		this.persistDirty.cancel()

		return this.persistNow()
	}

	/**
	 * Mirror a newly-known file into every persistent cache that downstream
	 * code reads from. Call after any optimistic `driveItemsQueryUpdate()` that
	 * adds a file (upload completion, socket FileNew/FileRestore/FileArchiveRestored,
	 * move-to-destination, etc.). The reference implementation that this mirrors
	 * lives inline in `src/queries/useDriveItems.query.ts:fetchData()`.
	 */
	public cacheNewFile(file: File, driveItem: Extract<DriveItem, { type: "file" }>): void {
		this.uuidToAnyDriveItem.set(file.uuid, driveItem)
		this.fileUuidToNormalFile.set(file.uuid, file)
	}

	/**
	 * Mirror a newly-known (own / non-shared) directory into every persistent
	 * cache. Use after any optimistic add of a directory to the TanStack listing
	 * (createDirectory, socket FolderSubCreated/FolderRestore, move-to-destination).
	 */
	public cacheNewNormalDir(dir: Dir, driveItem: Extract<DriveItem, { type: "directory" }>): void {
		this.uuidToAnyDriveItem.set(dir.uuid, driveItem)

		if (driveItem.data.decryptedMeta?.name) {
			this.directoryUuidToName.set(dir.uuid, driveItem.data.decryptedMeta.name)
		}

		const normalDir = new AnyNormalDir.Dir(dir)

		this.directoryUuidToAnyNormalDir.set(dir.uuid, normalDir)
		this.directoryUuidToAnyDirWithContext.set(dir.uuid, new AnyDirWithContext.Normal(normalDir))
	}

	/**
	 * Refresh the cached value for an item that already exists in the persistent
	 * caches. Use after any in-place mutation (rename / favorite / color /
	 * timestamps / public-link toggle / version restore / metadata-changed event).
	 * For files, pass the updated raw SDK `File` if available so subsequent socket
	 * reads of `fileUuidToNormalFile` see the new shape.
	 */
	public refreshCachedItem(driveItem: DriveItem, file?: File): void {
		this.uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)

		if (file && (driveItem.type === "file" || driveItem.type === "sharedFile" || driveItem.type === "sharedRootFile")) {
			this.fileUuidToNormalFile.set(file.uuid, file)
		}

		if (driveItem.type === "directory" && driveItem.data.decryptedMeta?.name) {
			this.directoryUuidToName.set(driveItem.data.uuid, driveItem.data.decryptedMeta.name)
		}
	}

	/**
	 * Forget every persistent-cache entry for a uuid. Use after a permanent
	 * delete (FileDeletedPermanent / FolderDeletedPermanent, deletePermanently,
	 * emptyTrash). Do NOT use for trash/archive — the item still exists, just
	 * lives in a different listing.
	 */
	public forgetItem(uuid: string): void {
		this.uuidToAnyDriveItem.delete(uuid)
		this.fileUuidToNormalFile.delete(uuid)
		this.directoryUuidToName.delete(uuid)
		this.directoryUuidToAnyNormalDir.delete(uuid)
		this.directoryUuidToAnyDirWithContext.delete(uuid)
		this.directoryUuidToAnySharedDirWithContext.delete(uuid)
		this.directoryUuidToAnyLinkedDirWithMeta.delete(uuid)
	}

	public clear(): void {
		this.persistDirty.cancel()
		this.clearGeneration++
		this.locked = true

		this.secureStore.clear()

		for (const { map } of this.registry) {
			Map.prototype.clear.call(map)
			map.ready = false
		}

		this.dirtyUpserts.clear()
		this.dirtyDeletes.clear()
		this.dirtyClears.clear()

		for (const { key } of this.registry) {
			sqlite.kvAsync.removeByPrefix(key + ":").catch(err => {
				console.error(`[Cache] Failed to remove ${key}`, err)
			})
		}
	}
}

const cache = new Cache()

export default cache
