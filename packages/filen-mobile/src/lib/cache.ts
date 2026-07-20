import {
	AnyNormalDir,
	AnySharedDir,
	AnySharedDirWithContext,
	AnyLinkedDir,
	type SharedDir,
	type SharingRole,
	type SharedRootDirsAndFiles,
	type LinkedDirsAndFiles,
	type File,
	type DirPublicLink,
	type Dir
} from "@filen/sdk-rs"
import { type DriveItem } from "@/types"
import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix } from "@/lib/kvScan"
import { serialize, deserialize } from "@/lib/serializer"
import { AppState } from "react-native"
import logger from "@/lib/logger"

// Critical: When changing anything related to storage index/store/persistence format, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 1
export const GLOBAL_PREFIX = `cache:v${VERSION}`

const PERSIST_DEBOUNCE = 1000
const PERSIST_CHUNK_SIZE = 256

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
 *
 * Keys are the media-library ASSET ID (Android contentUri / iOS ph:// identifier) —
 * stable across the compress/convertHeic toggles that rewrite tree paths. Entries
 * persisted before this keying used the tree path (always "/"-prefixed, so the two key
 * generations are distinguishable); camera upload's hygiene prune re-keys those to the
 * asset id on the first clean foreground pass and falls back to the path key on reads
 * until then.
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

	// Session-scoped — rebuilt per process by fetches, mutations, and the boot warm-seed; never
	// persisted (decrypted metadata lives in memory only).
	public readonly uuidToAnyDriveItem = new Map<string, DriveItem>()
	public readonly fileUuidToNormalFile = new Map<string, File>()
	public readonly directoryUuidToAnySharedDirWithContext = new Map<string, AnySharedDirWithContext>()
	public readonly directoryUuidToAnyNormalDir = new Map<string, AnyNormalDir>()
	public readonly directoryUuidToAnyLinkedDirWithMeta = new Map<
		string,
		{
			dir: AnyLinkedDir
			meta: DirPublicLink
		}
	>()
	public readonly chatAttachmentLayouts = new Map<
		string,
		{
			width: number
			height: number
		}
	>()

	// Durable — the only maps still independently persisted to SQLite KV (the camera-upload ledger).
	// The string arm of the union is the LEGACY persisted shape (bare md5) — see
	// CameraUploadHashEntry. Writers must always write the object shape.
	public readonly cameraUploadHashes: PersistentMap<CameraUploadHashEntry | string>
	// assetId → count of BACKGROUND uploads of this asset aborted by the run budget /
	// OS expiration (audit B4, 2026-06-11). Persisted because each background run may be
	// a fresh headless process and cancel() clears the in-memory failure counter — without
	// this, an asset that can never finish inside the OS window is re-picked every run
	// forever. Background delta picks skip counts >= MAX_BACKGROUND_UPLOAD_ABORTS
	// (cameraUpload.ts); any successful upload of the asset deletes its entry.
	public readonly cameraUploadBackgroundAborts: PersistentMap<number>

	public constructor() {
		this.cameraUploadHashes = this.createMap<CameraUploadHashEntry | string>("cameraUploadHashes")
		this.cameraUploadBackgroundAborts = this.createMap<number>("cameraUploadBackgroundAborts")

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
	private restored = false

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

				logger.debug("cache", "Persisting changes (background)", { count: commands.length })

				const db = await sqlite.openDb()

				// A clear() that lands between draining the dirty sets and opening the DB must win:
				// writing the just-drained commands would re-INSERT the wiped rows (logout leak).
				if (generation !== this.clearGeneration) {
					return
				}

				await db.executeBatch(commands)

				logger.debug("cache", "Background batch persisted", { durationMs: (performance.now() - now).toFixed(2) })
			} catch (err) {
				logger.error("cache", "Background batch persist failed — mutations re-queued", { error: err })

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

			logger.debug("cache", "Persisting changes (async)", { count: commands.length })

			const db = await sqlite.openDb()

			if (generation !== this.clearGeneration) {
				return
			}

			await db.executeBatch(commands)

			logger.debug("cache", "Async batch persisted", { durationMs: (performance.now() - now).toFixed(2) })
		} catch (err) {
			logger.error("cache", "Async batch persist failed — mutations re-queued", { error: err })

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
		// Once per session (audit B2b, 2026-06-11): setup() can run more than once in a
		// process (iOS cold background launch runs the task body's setup AND RootLayout's;
		// a warm Android process re-runs setup per WorkManager fire). Re-restoring would
		// redo full-table scans over every registered map and clobber newer in-memory
		// entries with older disk rows (disk lags the maps by the persist debounce).
		// clear() (logout) re-arms; a failed restore leaves the flag unset so the next
		// setup() retries.
		if (this.restored) {
			return
		}

		const now = performance.now()
		const rowCounts: string[] = []

		const db = await sqlite.openDb()

		const results = await Promise.allSettled(
			this.registry.map(async ({ key, map }) => {
				const prefix = key + ":"
				const prefixLength = prefix.length

				// Paged walk (not one full-range executeRaw): the item maps hold one row per item
				// ever seen, so a large account's scan used to materialize every row's JSON string
				// next to its parsed entry in one burst — the boot-OOM pattern. Paging bounds
				// raw-string residency; a deserialize throw still rejects this map's restore
				// mid-walk exactly like the single-scan version did mid-loop.
				const rowCount = await forEachKvRowByPrefix(db, prefix, (rowKey, value) => {
					Map.prototype.set.call(map, rowKey.slice(prefixLength), deserialize(value))
				})

				rowCounts.push(`${key}=${rowCount}`)
			})
		)

		for (let i = 0; i < results.length; i++) {
			const result = results[i] as PromiseSettledResult<void>

			if (result.status === "rejected") {
				const { key } = this.registry[i] as MapEntry

				logger.error("cache", "Map restore failed — map cleared", { mapKey: key, error: String(result.reason) })

				sqlite.kvAsync.removeByPrefix(key + ":").catch(removeErr => {
					logger.error("cache", "Failed to remove corrupted map rows from SQLite", { mapKey: key, error: removeErr })
				})
			}
		}

		for (const { map } of this.registry) {
			map.ready = true
		}

		// A fresh authenticated session has hydrated — re-enable persistence after a prior logout lock.
		this.locked = false
		this.restored = true

		logger.info("cache", "Cache restored", { durationMs: (performance.now() - now).toFixed(2), rowCounts: rowCounts.join(", ") })
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
	//
	// The `driveItem` params below are typed as the full DriveItem union (not the narrowed
	// Extract<>) so fetchData — whose unwrap builders return the union — can call these without
	// a per-branch narrowing cast; the strongly-typed RAW SDK param (file/dir) is what drives
	// the derived-cache construction, so correctness is preserved.
	public cacheNewFile(file: File, driveItem: DriveItem): void {
		this.uuidToAnyDriveItem.set(file.uuid, driveItem)
		this.fileUuidToNormalFile.set(file.uuid, file)
	}

	/**
	 * Mirror a newly-known (own / non-shared) directory into every persistent
	 * cache. Use after any optimistic add of a directory to the TanStack listing
	 * (createDirectory, socket FolderSubCreated/FolderRestore, move-to-destination).
	 */
	public cacheNewNormalDir(dir: Dir, driveItem: DriveItem): void {
		this.uuidToAnyDriveItem.set(dir.uuid, driveItem)
		this.directoryUuidToAnyNormalDir.set(dir.uuid, new AnyNormalDir.Dir(dir))
	}

	/**
	 * Mirror a newly-known SHARED (non-root) directory into every persistent cache.
	 * Reference implementation: the "shared" branch of useDriveItems.query.ts fetchData().
	 * `sharedOut` mirrors fetchData: a directory you share OUT is your own, so it ALSO has a
	 * valid normal-dir view (cached under directoryUuidToAnyNormalDir); a directory shared IN
	 * (someone else's) has no normal-dir view and is not.
	 */
	public cacheNewSharedDir(
		dir: SharedDir & { sharingRole: SharingRole },
		driveItem: DriveItem,
		opts: { sharedOut: boolean }
	): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		this.directoryUuidToAnySharedDirWithContext.set(
			uuid,
			AnySharedDirWithContext.new({
				dir: new AnySharedDir.Dir(dir),
				shareInfo: dir.sharingRole
			})
		)

		if (opts.sharedOut) {
			this.directoryUuidToAnyNormalDir.set(uuid, new AnyNormalDir.Dir(dir.inner))
		}
	}

	/**
	 * Mirror a newly-known SHARED ROOT directory (top-level shared-in/out entry) into every
	 * persistent cache. Reference: the "sharedRoot" branch of fetchData().
	 */
	public cacheNewSharedRootDir(dir: SharedRootDirsAndFiles["dirs"][number], driveItem: DriveItem): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		this.directoryUuidToAnySharedDirWithContext.set(
			uuid,
			AnySharedDirWithContext.new({
				dir: new AnySharedDir.Root(dir),
				shareInfo: dir.sharingRole
			})
		)
	}

	/**
	 * Mirror a newly-known SHARED file into the caches. Reference: the "shared" branch of
	 * fetchData(). A file you share OUT is also cached as a normal File (own file, sharingRole
	 * stripped); a file shared IN is referenced by uuid only.
	 */
	public cacheNewSharedFile(
		file: File & { sharingRole: SharingRole },
		driveItem: DriveItem,
		opts: { sharedOut: boolean }
	): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		if (opts.sharedOut) {
			const { sharingRole: _, ...normalFile } = file

			this.fileUuidToNormalFile.set(uuid, normalFile)
		}
	}

	/**
	 * Mirror a newly-known LINKED directory (public-link browse) into the caches. Reference:
	 * the "linked" branch of fetchData(). The uuid→item mapping is always seeded; the linked-meta
	 * cache (which needs the parent link's meta, not carried on the DriveItem) is seeded only when
	 * `meta` is known — matching fetchData, which caches those under `if (meta)`.
	 */
	public cacheNewLinkedDir(dir: LinkedDirsAndFiles["dirs"][number], driveItem: DriveItem, meta: DirPublicLink | null): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		if (!meta) {
			return
		}

		this.directoryUuidToAnyLinkedDirWithMeta.set(uuid, {
			dir: new AnyLinkedDir.Dir(dir),
			meta
		})
	}

	/**
	 * Reference an item by uuid only (uuidToAnyDriveItem), with no derived-cache seeding.
	 * Mirrors the "offline", shared-root-file and linked-file branches of fetchData(), which
	 * cache only the uuid→item mapping.
	 */
	public cacheDriveItemReference(driveItem: DriveItem): void {
		this.uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)
	}

	/**
	 * Seed every cache that can be derived from a DriveItem ALONE, dispatching on the item's own type
	 * discriminator (item.data IS the SDK type each helper needs). Used by the drive optimistic path and
	 * the boot warm-seed so a listing mutation reseeds the type-derived caches too, not just
	 * uuidToAnyDriveItem, without a refetch. Context the item can't carry is handled conservatively:
	 *   - the sharedOut refinement (a `sharedDirectory` ALSO getting the normal-dir view) is taken from
	 *     `opts.sharedOut` — the caller knows the listing's context (default false); a shared FILE stays
	 *     shared-in (its raw-size normal view can't be rebuilt from a DriveItem);
	 *   - a `directory` item is always treated as normal (linked browse is read-only — never
	 *     optimistically updated — and the linked caches need the parent link meta, not on the item);
	 *   - a shared item whose optional sharingRole didn't survive onto the DriveItem falls back to a
	 *     uuid-only reference instead of building a share context with a missing role.
	 */
	public cacheDriveItem(item: DriveItem, opts?: { sharedOut?: boolean }): void {
		switch (item.type) {
			case "file": {
				this.cacheNewFile(item.data, item)

				break
			}

			case "directory": {
				this.cacheNewNormalDir(item.data, item)

				break
			}

			case "sharedDirectory": {
				if (item.data.sharingRole) {
					this.cacheNewSharedDir({ ...item.data, sharingRole: item.data.sharingRole }, item, {
						sharedOut: opts?.sharedOut ?? false
					})
				} else {
					this.cacheDriveItemReference(item)
				}

				break
			}

			case "sharedRootDirectory": {
				this.cacheNewSharedRootDir(item.data, item)

				break
			}

			case "sharedFile": {
				this.cacheNewSharedFile(item.data, item, { sharedOut: false })

				break
			}

			case "sharedRootFile": {
				this.cacheDriveItemReference(item)

				break
			}
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
		this.directoryUuidToAnyNormalDir.delete(uuid)
		this.directoryUuidToAnySharedDirWithContext.delete(uuid)
		this.directoryUuidToAnyLinkedDirWithMeta.delete(uuid)
	}

	public clear(): void {
		this.persistDirty.cancel()
		this.clearGeneration++
		this.locked = true
		this.restored = false

		this.secureStore.clear()
		this.rootUuid = null

		for (const { map } of this.registry) {
			Map.prototype.clear.call(map)
			map.ready = false
		}

		// Session-scoped plain Maps — no ready flag, just drop their in-memory entries.
		this.uuidToAnyDriveItem.clear()
		this.fileUuidToNormalFile.clear()
		this.directoryUuidToAnySharedDirWithContext.clear()
		this.directoryUuidToAnyNormalDir.clear()
		this.directoryUuidToAnyLinkedDirWithMeta.clear()
		this.chatAttachmentLayouts.clear()

		this.dirtyUpserts.clear()
		this.dirtyDeletes.clear()
		this.dirtyClears.clear()

		for (const { key } of this.registry) {
			sqlite.kvAsync.removeByPrefix(key + ":").catch(err => {
				logger.error("cache", "Logout wipe: failed to remove map rows from SQLite", { mapKey: key, error: err })
			})
		}
	}
}

const cache = new Cache()

export default cache
