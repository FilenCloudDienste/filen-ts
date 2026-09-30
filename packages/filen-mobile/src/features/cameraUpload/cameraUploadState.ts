import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix, KV_SMALL_ROW_PAGE_SIZE, prefixUpperBound } from "@/lib/kvScan"
import { serialize, deserialize } from "@/lib/serializer"
import logger from "@/lib/logger"

// Feature-owned kv prefixes. Per-entry rows: `cameraUpload:hashes:<key>` (key = asset id, or a
// legacy "/"-prefixed tree path) and `cameraUpload:aborts:<assetId>`.
const HASHES_PREFIX = "cameraUpload:hashes:"
const ABORTS_PREFIX = "cameraUpload:aborts:"

// Single row (not a prefix family): the remote directory uuid the hash shield was built against.
const DESTINATION_KEY = "cameraUpload:destination"

// Rows per executeBatch chunk for a wave — bounds the native hop / arg-array size.
const APPLY_CHUNK_SIZE = 256

type KvCommand = [string, (string | Uint8Array)[]]

type Ledger<T> = {
	prefix: string
	// Capitalized; used in the scan-failure log lines.
	label: string
	map: Map<string, T>
	// Throws on a corrupt row.
	parse: (value: string) => T
	loaded: boolean
	promise: Promise<void> | null
}

/**
 * Value shape for a hash ledger entry. `md5` is the hash of the asset content as it
 * was last uploaded (or last verified against the cache); `verifiedModificationTime`
 * is the asset's modificationTime at the moment that md5 was last verified, letting
 * camera upload skip re-hashing (and re-downloading iCloud-offloaded assets) when the
 * mtime is unchanged. `-1` means "never verified" and always forces one hash.
 *
 * Entries persisted before this shape existed are plain md5 strings — they are read into
 * memory as `{ md5: <string>, verifiedModificationTime: -1 }` and persisted in the object
 * shape on the next write (lazy migration; no version bump / cache wipe needed).
 *
 * `paths` lists the tree paths this asset's content is known uploaded (or verified) under —
 * one asset can belong to several selected albums and must reach EVERY album folder, so the
 * upload-skip shield applies per path, not per asset. An entry without `paths` (legacy shape)
 * covers all paths, preserving the pre-`paths` skip semantics.
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
	paths?: string[]
}

// Legacy rows are bare md5 strings; "never verified" (-1) makes the next encounter hash once.
function normalizeHashEntry(value: CameraUploadHashEntry | string): CameraUploadHashEntry {
	if (typeof value === "string") {
		return {
			md5: value,
			verifiedModificationTime: -1
		}
	}

	return value
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
	public readonly hashes = new Map<string, CameraUploadHashEntry>()
	public readonly aborts = new Map<string, number>()

	// Per-ledger load state. The maps are the public ones above; `loaded`/`promise` are reset by
	// clearForLogout.
	private readonly hashLedger: Ledger<CameraUploadHashEntry> = {
		prefix: HASHES_PREFIX,
		label: "Hash",
		map: this.hashes,
		parse: value => normalizeHashEntry(deserialize(value) as CameraUploadHashEntry | string),
		loaded: false,
		promise: null
	}

	private readonly abortLedger: Ledger<number> = {
		prefix: ABORTS_PREFIX,
		label: "Abort",
		map: this.aborts,
		parse: value => deserialize(value) as number,
		loaded: false,
		promise: null
	}

	// Set true by clearForLogout (account-scoped ledger). While locked, writes refuse so a worker-tail
	// write that STARTS after the logout's global `DELETE FROM kv` can't re-insert into the next
	// account's shield (sqlite's clearGeneration only discards writes that started before the wipe).
	// A fresh session's load un-locks.
	private locked = false

	// Bumped by clearForLogout; a load in flight during a wipe captures it before scanning and discards
	// its results if it changed, so stale disk rows never repopulate the next account's memory.
	private generation = 0

	/**
	 * Foreground: page the whole hash index into memory. Single-flight. Captures the generation before
	 * the scan and discards its results if a clear bumped it mid-scan. A scan failure logs a warn,
	 * range-deletes the corrupt prefix, and proceeds empty (the shield self-heals by re-verification).
	 */
	public loadHashes(): Promise<void> {
		return this.loadLedger(this.hashLedger)
	}

	/**
	 * Both modes call this before first aborts use (tiny, self-pruning cardinality). Same shape as
	 * loadHashes.
	 */
	public loadAborts(): Promise<void> {
		return this.loadLedger(this.abortLedger)
	}

	private loadLedger<T>(ledger: Ledger<T>): Promise<void> {
		if (ledger.loaded) {
			return Promise.resolve()
		}

		if (ledger.promise) {
			return ledger.promise
		}

		const promise = this.scanLedger(ledger).finally(() => {
			if (ledger.promise === promise) {
				ledger.promise = null
			}
		})

		ledger.promise = promise

		return promise
	}

	private async scanLedger<T>(ledger: Ledger<T>): Promise<void> {
		const generation = this.generation
		const scanned = new Map<string, T>()

		try {
			const db = await sqlite.openDb()

			const badKeys: string[] = []

			await forEachKvRowByPrefix(
				db,
				ledger.prefix,
				(rowKey, value) => {
					// One corrupt row must not wipe the whole ledger — skip and drop just that row.
					try {
						scanned.set(rowKey.slice(ledger.prefix.length), ledger.parse(value))
					} catch {
						badKeys.push(rowKey)
					}
				},
				KV_SMALL_ROW_PAGE_SIZE
			)

			if (badKeys.length > 0) {
				logger.warn("cameraUploadState", `Dropping corrupt ${ledger.label.toLowerCase()} ledger rows`, { count: badKeys.length })

				await db.executeBatch(badKeys.map(key => ["DELETE FROM kv WHERE key = ?", [key]] as KvCommand))
			}
		} catch (err) {
			logger.warn("cameraUploadState", `${ledger.label} ledger scan failed — wiping corrupt prefix and proceeding empty`, { error: err })

			// Stale-generation zombie: the logout wipe already removed the prefix — never touch
			// the next session's rows.
			if (generation !== this.generation) {
				return
			}

			await this.rangeDeletePrefix(ledger.prefix).catch(() => {})

			// Re-check: a logout landing during the wipe above must keep the latch closed.
			if (generation === this.generation) {
				ledger.loaded = true
				this.locked = false
			}

			return
		}

		if (generation !== this.generation) {
			return
		}

		for (const [key, value] of scanned) {
			ledger.map.set(key, value)
		}

		ledger.loaded = true
		// A fresh session's committed load re-enables writes; un-latching any earlier (before the
		// generation check) would let a logout-window zombie load defeat the latch.
		this.locked = false
	}

	private async rangeDeletePrefix(prefix: string): Promise<void> {
		const db = await sqlite.openDb()

		await db.executeBatch([["DELETE FROM kv WHERE key >= ? AND key < ?", [prefix, prefixUpperBound(prefix)]]])
	}

	// Foreground read contract: valid only after loadHashes(). Pure memory read, never throws.
	public getHashSync(key: string): CameraUploadHashEntry | undefined {
		return this.hashes.get(key)
	}

	// Background read: memory if the index was loaded, else a single kv point-read. A shield read must
	// NEVER throw into the worker, so the kv path is internally guarded and degrades to undefined.
	public async getHash(key: string): Promise<CameraUploadHashEntry | undefined> {
		if (this.hashLedger.loaded) {
			return this.hashes.get(key)
		}

		try {
			const value = await sqlite.kvAsync.get<CameraUploadHashEntry | string>(HASHES_PREFIX + key)

			return value === null ? undefined : normalizeHashEntry(value)
		} catch (err) {
			logger.warn("cameraUploadState", "Background hash read failed", { key, error: err })

			return undefined
		}
	}

	/**
	 * Resolve many shield entries at once.
	 *
	 * The delta gate consults the ledger for every asset whose remote copy looks older, which on a
	 * browsed library is thousands of keys. Foreground answers from the loaded index; background —
	 * which deliberately does NOT page the whole ledger in — would otherwise pay one serial native
	 * round trip per key, so it goes through a batched read instead.
	 */
	public async getHashMany(keys: string[]): Promise<Map<string, CameraUploadHashEntry>> {
		const found = new Map<string, CameraUploadHashEntry>()

		if (keys.length === 0) {
			return found
		}

		if (this.hashLedger.loaded) {
			for (const key of keys) {
				const value = this.hashes.get(key)

				if (value !== undefined) {
					found.set(key, value)
				}
			}

			return found
		}

		try {
			const rows = await sqlite.kvAsync.getMany<CameraUploadHashEntry | string>(keys.map(key => HASHES_PREFIX + key))

			for (const [key, value] of rows) {
				found.set(key.slice(HASHES_PREFIX.length), normalizeHashEntry(value))
			}
		} catch (err) {
			// Same policy as the point read: a failed shield lookup degrades to "not verified", which
			// costs a hash (and possibly an upload), never a skipped backup.
			logger.warn("cameraUploadState", "Background batched hash read failed", { keys: keys.length, error: err })
		}

		return found
	}

	// Loaded-memory snapshot of the hash keys (foreground; after loadHashes).
	public hashKeys(): string[] {
		return [...this.hashes.keys()]
	}

	// Loaded-memory read (both modes call loadAborts first).
	public getAbort(id: string): number | undefined {
		return this.aborts.get(id)
	}

	public async setHash(key: string, entry: CameraUploadHashEntry): Promise<void> {
		if (this.locked) {
			return
		}

		this.hashes.set(key, entry)

		await sqlite.kvAsync.set(HASHES_PREFIX + key, entry)
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
	public async applyHashBatch(batch: { upserts?: [string, CameraUploadHashEntry][]; deletes?: string[] }): Promise<void> {
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
	/**
	 * The remote directory the shield belongs to, or null when it has never been recorded.
	 *
	 * A shield entry says "this content is already at its destination", but the tree paths it stores
	 * are RELATIVE to the camera-upload root — so they keep matching after the destination changes,
	 * and an entirely empty new folder reads as "everything was deleted remotely", which camera
	 * upload deliberately does not re-upload. Pairing the shield with the destination it was built
	 * against is what makes that distinguishable.
	 */
	public async getSyncedDestination(): Promise<string | null> {
		// Deliberately NOT caught. `null` means "never recorded", and the caller answers that by
		// ADOPTING the current destination — so folding a read failure into null would record the new
		// destination against a shield built for the old one, and the mismatch would never be seen
		// again. The caller skips both branches when this rejects, leaving the next pass to retry.
		return await sqlite.kvAsync.get<string>(DESTINATION_KEY)
	}

	public async setSyncedDestination(uuid: string): Promise<void> {
		if (this.locked) {
			return
		}

		await sqlite.kvAsync.set(DESTINATION_KEY, uuid)
	}

	/**
	 * Drop the hash shield only, leaving the abort ledger intact.
	 *
	 * Distinct from clearForLogout, which also drops aborts and locks the store against late writes.
	 * The abort counts mean "this asset never fits an OS background window", which stays true at a new
	 * destination — clearing them would re-burn background budgets on assets that cannot finish.
	 */
	public async clearHashes(): Promise<void> {
		if (this.locked) {
			return
		}

		// Bumped for the same reason clearForLogout bumps it: a load already scanning captured the
		// previous generation and would otherwise commit its pre-wipe rows into memory AFTER this
		// clear, resurrecting the whole shield over an emptied kv. Unreachable through today's single
		// caller, but the primitive must not depend on that.
		this.generation++

		await this.rangeDeletePrefix(HASHES_PREFIX)

		this.hashes.clear()
	}

	public clearForLogout(): void {
		this.generation++
		this.locked = true

		this.hashes.clear()
		this.aborts.clear()

		this.hashLedger.loaded = false
		this.abortLedger.loaded = false

		this.hashLedger.promise = null
		this.abortLedger.promise = null
	}
}

const cameraUploadState = new CameraUploadState()

export default cameraUploadState
