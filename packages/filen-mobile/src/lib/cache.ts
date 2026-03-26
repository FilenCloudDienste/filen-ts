import type { Note, Chat, AnyNormalDir, AnySharedDirWithContext, AnyDirWithContext } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import sqlite from "@/lib/sqlite"
import { pack } from "@/lib/msgpack"

const VERSION = 1
const GLOBAL_PREFIX = `cache:v${VERSION}`

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

class Cache {
	private readonly registry: MapEntry[] = []
	private readonly dirtyUpserts = new Map<string, Set<string>>()
	private readonly dirtyDeletes = new Map<string, Set<string>>()
	private readonly dirtyClears = new Set<string>()

	// Not persisted — managed separately by secureStore.ts with its own encryption
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public readonly secureStore = new Map<string, any>()

	// Persisted — each entry independently persisted to SQLite KV
	public readonly directoryUuidToName: PersistentMap<string>
	public readonly noteUuidToNote: PersistentMap<Note>
	public readonly chatUuidToChat: PersistentMap<Chat>
	public readonly uuidToDriveItem: PersistentMap<DriveItem>
	public readonly directoryUuidToAnySharedDirWithContext: PersistentMap<AnySharedDirWithContext>
	public readonly directoryUuidToAnyNormalDir: PersistentMap<AnyNormalDir>
	public readonly directoryUuidToAnyDirWithContext: PersistentMap<AnyDirWithContext>
	public readonly availableThumbnails: PersistentMap<boolean>

	public constructor() {
		this.directoryUuidToName = this.createMap<string>("directoryUuidToName")
		this.noteUuidToNote = this.createMap<Note>("noteUuidToNote")
		this.chatUuidToChat = this.createMap<Chat>("chatUuidToChat")
		this.uuidToDriveItem = this.createMap<DriveItem>("uuidToDriveItem")
		this.directoryUuidToAnySharedDirWithContext = this.createMap<AnySharedDirWithContext>("directoryUuidToAnySharedDirWithContext")
		this.directoryUuidToAnyNormalDir = this.createMap<AnyNormalDir>("directoryUuidToAnyNormalDir")
		this.directoryUuidToAnyDirWithContext = this.createMap<AnyDirWithContext>("directoryUuidToAnyDirWithContext")
		this.availableThumbnails = this.createMap<boolean>("availableThumbnails")
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

					this.dirtyDeletes.get(key)?.delete(mutation.entryKey)

					break
				}

				case "delete": {
					let deletes = this.dirtyDeletes.get(key)

					if (!deletes) {
						deletes = new Set()

						this.dirtyDeletes.set(key, deletes)
					}

					deletes.add(mutation.entryKey)

					this.dirtyUpserts.get(key)?.delete(mutation.entryKey)

					break
				}

				case "clear": {
					this.dirtyClears.add(key)

					this.dirtyUpserts.delete(key)
					this.dirtyDeletes.delete(key)

					break
				}
			}

			this.schedulePersist()
		})

		this.registry.push({
			key,
			map: map as PersistentMap<unknown>
		})

		return map
	}

	private persistScheduled = false

	private schedulePersist(): void {
		if (this.persistScheduled) {
			return
		}

		this.persistScheduled = true

		queueMicrotask(() => {
			this.persistScheduled = false

			this.persistDirty()
		})
	}

	private persistDirty(): void {
		if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0 && this.dirtyClears.size === 0) {
			return
		}

		const commands: [string, (string | Uint8Array)[]][] = []

		for (const mapKey of this.dirtyClears) {
			commands.push(["DELETE FROM kv WHERE key LIKE ?", [mapKey + ":%"]])
		}

		for (const [mapKey, entryKeys] of this.dirtyDeletes) {
			for (const entryKey of entryKeys) {
				commands.push(["DELETE FROM kv WHERE key = ?", [mapKey + ":" + entryKey]])
			}
		}

		for (const entry of this.registry) {
			const upsertKeys = this.dirtyUpserts.get(entry.key)

			if (!upsertKeys) {
				continue
			}

			for (const entryKey of upsertKeys) {
				const value = entry.map.get(entryKey)

				if (value !== undefined) {
					commands.push([
						"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
						[entry.key + ":" + entryKey, new Uint8Array(pack(value))]
					])
				}
			}
		}

		this.dirtyClears.clear()
		this.dirtyDeletes.clear()
		this.dirtyUpserts.clear()

		if (commands.length === 0) {
			return
		}

		sqlite
			.openDb()
			.then(db => db.executeBatch(commands))
			.catch(err => {
				console.error("[Cache] Failed to batch persist", err)
			})
	}

	/**
	 * Populate maps from SQLite. Uses Map.prototype.set to bypass
	 * PersistentMap's onMutate and avoid a write-back cycle.
	 * Call during app setup before first render.
	 */
	public async restore(): Promise<void> {
		const results = await Promise.allSettled(
			this.registry.map(async ({ key, map }) => {
				const prefix = key + ":"
				const entries = await sqlite.kvAsync.getByPrefix<unknown>(prefix)

				for (const [fullKey, value] of entries) {
					const entryKey = fullKey.slice(prefix.length)

					Map.prototype.set.call(map, entryKey, value)
				}
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
	}

	public flush(): void {
		this.persistScheduled = false

		this.persistDirty()
	}

	public clear(): void {
		this.secureStore.clear()

		for (const { map } of this.registry) {
			Map.prototype.clear.call(map)
		}

		this.persistScheduled = false

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
