import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix, prefixUpperBound } from "@/lib/kvScan"
import { serialize, deserialize } from "@/lib/serializer"
import logger from "@/lib/logger"

// Feature-owned kv prefixes. Per-entry rows: `cameraUpload:hashes:<key>` (key = asset id, or a
// legacy "/"-prefixed tree path) and `cameraUpload:aborts:<assetId>`.
const HASHES_PREFIX = "cameraUpload:hashes:"
const ABORTS_PREFIX = "cameraUpload:aborts:"

// Rows per executeBatch chunk for a wave — bounds the native hop / arg-array size.
const APPLY_CHUNK_SIZE = 256

type KvCommand = [string, (string | Uint8Array)[]]

/**
 * Value shape for a hash ledger entry. `md5` is the hash of the asset content as it
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

/**
 * Durable, feature-owned camera-upload ledger. Two per-entry kv stores, previously registered maps
 * on the shared cache: the md5/verified-mtime hash shield and the background-abort counter. Owning
 * them here keeps headless camera-upload fires off the shared cache machinery. On existing installs
 * the store simply starts empty — the old `cache:v1:` rows are abandoned in place (the
 * legacy-row sweep in setup.ts removes them); the accepted one-time cost is a shield rebuild via
 * re-verification.
 *
 * The abort ledger (`aborts`): assetId → count of BACKGROUND uploads of this asset aborted by the
 * run budget / OS expiration. Persisted because each background run may be a fresh headless process
 * and cancel() clears the in-memory failure counter — without this, an asset that can never finish
 * inside the OS window is re-picked every run forever. Background delta picks skip counts >=
 * MAX_BACKGROUND_UPLOAD_ABORTS (cameraUpload.ts); any successful upload of the asset deletes its entry.
 */
export class CameraUploadState {
	// Public readonly for test introspection; the loaded-read contract is expressed by the methods
	// below (getHashSync/hashKeys/getAbort), which are what callers use.
	public readonly hashes = new Map<string, CameraUploadHashEntry | string>()
	public readonly aborts = new Map<string, number>()

	private hashesLoaded = false
	private abortsLoaded = false

	// Set true by clearForLogout (account-scoped ledger). While locked, writes refuse so a worker-tail
	// write that STARTS after the logout's global `DELETE FROM kv` can't re-insert into the next
	// account's shield (sqlite's clearGeneration only discards writes that started before the wipe).
	// A fresh session's load un-locks.
	private locked = false

	// Bumped by clearForLogout; a load in flight during a wipe captures it before scanning and discards
	// its results if it changed, so stale disk rows never repopulate the next account's memory.
	private generation = 0

	private loadHashesPromise: Promise<void> | null = null
	private loadAbortsPromise: Promise<void> | null = null

	/**
	 * Foreground: page the whole hash index into memory. Single-flight. Captures the generation before
	 * the scan and discards its results if a clear bumped it mid-scan. A scan failure logs a warn,
	 * range-deletes the corrupt prefix, and proceeds empty (the shield self-heals by re-verification).
	 */
	public loadHashes(): Promise<void> {
		if (this.hashesLoaded) {
			return Promise.resolve()
		}

		if (this.loadHashesPromise) {
			return this.loadHashesPromise
		}

		const promise = this.doLoadHashes().finally(() => {
			if (this.loadHashesPromise === promise) {
				this.loadHashesPromise = null
			}
		})

		this.loadHashesPromise = promise

		return promise
	}

	private async doLoadHashes(): Promise<void> {
		const generation = this.generation
		const scanned = new Map<string, CameraUploadHashEntry | string>()

		try {
			const db = await sqlite.openDb()

			const badKeys: string[] = []

			await forEachKvRowByPrefix(db, HASHES_PREFIX, (rowKey, value) => {
				// One corrupt row must not wipe the whole shield — skip and drop just that row.
				try {
					scanned.set(rowKey.slice(HASHES_PREFIX.length), deserialize(value) as CameraUploadHashEntry | string)
				} catch {
					badKeys.push(rowKey)
				}
			})

			if (badKeys.length > 0) {
				logger.warn("cameraUploadState", "Dropping corrupt hash ledger rows", { count: badKeys.length })

				await db.executeBatch(badKeys.map(key => ["DELETE FROM kv WHERE key = ?", [key]] as KvCommand))
			}
		} catch (err) {
			logger.warn("cameraUploadState", "Hash ledger scan failed — wiping corrupt prefix and proceeding empty", { error: err })

			// Stale-generation zombie: the logout wipe already removed the prefix — never touch
			// the next session's rows.
			if (generation !== this.generation) {
				return
			}

			await this.rangeDeletePrefix(HASHES_PREFIX).catch(() => {})

			// Re-check: a logout landing during the wipe above must keep the latch closed.
			if (generation === this.generation) {
				this.hashesLoaded = true
				this.locked = false
			}

			return
		}

		if (generation !== this.generation) {
			return
		}

		for (const [key, value] of scanned) {
			this.hashes.set(key, value)
		}

		this.hashesLoaded = true
		// A fresh session's committed load re-enables writes; un-latching any earlier (before the
		// generation check) would let a logout-window zombie load defeat the latch.
		this.locked = false
	}

	/**
	 * Both modes call this before first aborts use (tiny, self-pruning cardinality). Same shape as
	 * loadHashes.
	 */
	public loadAborts(): Promise<void> {
		if (this.abortsLoaded) {
			return Promise.resolve()
		}

		if (this.loadAbortsPromise) {
			return this.loadAbortsPromise
		}

		const promise = this.doLoadAborts().finally(() => {
			if (this.loadAbortsPromise === promise) {
				this.loadAbortsPromise = null
			}
		})

		this.loadAbortsPromise = promise

		return promise
	}

	private async doLoadAborts(): Promise<void> {
		const generation = this.generation
		const scanned = new Map<string, number>()

		try {
			const db = await sqlite.openDb()

			const badKeys: string[] = []

			await forEachKvRowByPrefix(db, ABORTS_PREFIX, (rowKey, value) => {
				// One corrupt row must not wipe the whole ledger — skip and drop just that row.
				try {
					scanned.set(rowKey.slice(ABORTS_PREFIX.length), deserialize(value) as number)
				} catch {
					badKeys.push(rowKey)
				}
			})

			if (badKeys.length > 0) {
				logger.warn("cameraUploadState", "Dropping corrupt abort ledger rows", { count: badKeys.length })

				await db.executeBatch(badKeys.map(key => ["DELETE FROM kv WHERE key = ?", [key]] as KvCommand))
			}
		} catch (err) {
			logger.warn("cameraUploadState", "Abort ledger scan failed — wiping corrupt prefix and proceeding empty", { error: err })

			// Stale-generation zombie: the logout wipe already removed the prefix — never touch
			// the next session's rows.
			if (generation !== this.generation) {
				return
			}

			await this.rangeDeletePrefix(ABORTS_PREFIX).catch(() => {})

			// Re-check: a logout landing during the wipe above must keep the latch closed.
			if (generation === this.generation) {
				this.abortsLoaded = true
				this.locked = false
			}

			return
		}

		if (generation !== this.generation) {
			return
		}

		for (const [key, value] of scanned) {
			this.aborts.set(key, value)
		}

		this.abortsLoaded = true
		this.locked = false
	}

	private async rangeDeletePrefix(prefix: string): Promise<void> {
		const db = await sqlite.openDb()

		await db.executeBatch([["DELETE FROM kv WHERE key >= ? AND key < ?", [prefix, prefixUpperBound(prefix)]]])
	}

	// Foreground read contract: valid only after loadHashes(). Pure memory read, never throws.
	public getHashSync(key: string): CameraUploadHashEntry | string | undefined {
		return this.hashes.get(key)
	}

	// Background read: memory if the index was loaded, else a single kv point-read. A shield read must
	// NEVER throw into the worker, so the kv path is internally guarded and degrades to undefined.
	public async getHash(key: string): Promise<CameraUploadHashEntry | string | undefined> {
		if (this.hashesLoaded) {
			return this.hashes.get(key)
		}

		try {
			return (await sqlite.kvAsync.get<CameraUploadHashEntry | string>(HASHES_PREFIX + key)) ?? undefined
		} catch (err) {
			logger.warn("cameraUploadState", "Background hash read failed", { key, error: err })

			return undefined
		}
	}

	// Loaded-memory snapshot of the hash keys (foreground; after loadHashes).
	public hashKeys(): string[] {
		return [...this.hashes.keys()]
	}

	// Loaded-memory read (both modes call loadAborts first).
	public getAbort(id: string): number | undefined {
		return this.aborts.get(id)
	}

	public async setHash(key: string, entry: CameraUploadHashEntry | string): Promise<void> {
		if (this.locked) {
			return
		}

		this.hashes.set(key, entry)

		await sqlite.kvAsync.set(HASHES_PREFIX + key, entry)
	}

	public async deleteHash(key: string): Promise<void> {
		if (this.locked) {
			return
		}

		this.hashes.delete(key)

		await sqlite.kvAsync.remove(HASHES_PREFIX + key)
	}

	public async setAbort(id: string, count: number): Promise<void> {
		if (this.locked) {
			return
		}

		this.aborts.set(id, count)

		await sqlite.kvAsync.set(ABORTS_PREFIX + id, count)
	}

	public async deleteAbort(id: string): Promise<void> {
		if (this.locked) {
			return
		}

		this.aborts.delete(id)

		await sqlite.kvAsync.remove(ABORTS_PREFIX + id)
	}

	// One awaited kv round for a whole enumeration wave — a 50k-library re-key must not become O(n)
	// serialized point writes. Memory first (synchronously), then chunked executeBatch.
	public async applyHashBatch(batch: { upserts?: [string, CameraUploadHashEntry | string][]; deletes?: string[] }): Promise<void> {
		if (this.locked) {
			return
		}

		const generation = this.generation
		const upserts = batch.upserts ?? []
		const deletes = batch.deletes ?? []

		for (const [key, value] of upserts) {
			this.hashes.set(key, value)
		}

		for (const key of deletes) {
			this.hashes.delete(key)
		}

		const commands: KvCommand[] = []

		for (const [key, value] of upserts) {
			commands.push(["INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [HASHES_PREFIX + key, serialize(value)]])
		}

		for (const key of deletes) {
			commands.push(["DELETE FROM kv WHERE key = ?", [HASHES_PREFIX + key]])
		}

		if (commands.length === 0) {
			return
		}

		const db = await sqlite.openDb()

		for (let i = 0; i < commands.length; i += APPLY_CHUNK_SIZE) {
			// Re-check per chunk: raw executeBatch bypasses the kv wipe generation, so a logout
			// landing mid-wave must stop the tail chunks from re-inserting into the emptied store.
			if (this.locked || generation !== this.generation) {
				return
			}

			await db.executeBatch(commands.slice(i, i + APPLY_CHUNK_SIZE))
		}
	}

	// Logout wipe. Bumps the generation, latches `locked`, empties both maps and resets the loaded
	// flags/single-flights. The kv rows die in the logout's global `DELETE FROM kv`; the latch exists
	// because sqlite's clearGeneration only discards writes that STARTED before the wipe — a
	// worker-tail write starting after it would re-insert and poison the next account's shield. Next
	// load un-locks.
	public clearForLogout(): void {
		this.generation++
		this.locked = true

		this.hashes.clear()
		this.aborts.clear()

		this.hashesLoaded = false
		this.abortsLoaded = false

		this.loadHashesPromise = null
		this.loadAbortsPromise = null
	}
}

const cameraUploadState = new CameraUploadState()

export default cameraUploadState
