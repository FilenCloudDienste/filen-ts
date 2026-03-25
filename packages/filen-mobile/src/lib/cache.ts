import type { Note, Chat, AnyNormalDir, AnySharedDirWithContext, AnyDirWithContext } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { debounce } from "es-toolkit/function"
import sqlite from "@/lib/sqlite"
import { AppState } from "react-native"
import { pack } from "@/lib/msgpack"

const VERSION = 1
const PERSIST_DEBOUNCE_MS = 1000

/**
 * Map subclass that calls an onMutate callback on set/delete/clear.
 * Used with a per-map debounced persist so any mutation schedules a batched SQLite write.
 */
export class PersistentMap<V> extends Map<string, V> {
	private readonly onMutate: () => void
	public ready: boolean = false

	public constructor(onMutate: () => void) {
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

		this.onMutate()

		return this
	}

	public override delete(key: string): boolean {
		this.assertReady()

		const result = super.delete(key)

		if (result) {
			this.onMutate()
		}

		return result
	}

	public override clear(): void {
		this.assertReady()

		if (this.size > 0) {
			super.clear()

			this.onMutate()
		}
	}
}

type MapEntry = {
	key: string
	map: PersistentMap<unknown>
}

class Cache {
	private readonly registry: MapEntry[] = []
	private readonly dirty = new Set<string>()

	// Not persisted — managed separately by secureStore.ts with its own encryption
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public readonly secureStore = new Map<string, any>()

	// Persisted — each PersistentMap is independently persisted to SQLite KV
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
		const key = `cache:v${VERSION}:${name}`

		const map = new PersistentMap<V>(() => {
			this.dirty.add(key)

			this.schedulePersist()
		})

		this.registry.push({
			key,
			map: map as PersistentMap<unknown>
		})

		return map
	}

	private readonly schedulePersist = debounce(
		() => {
			this.persistDirty()
		},
		PERSIST_DEBOUNCE_MS,
		{
			edges: ["trailing"]
		}
	)

	private persistDirty(): void {
		if (this.dirty.size === 0) {
			return
		}

		const commands: [string, (string | Uint8Array)[]][] = []

		for (const entry of this.registry) {
			if (!this.dirty.has(entry.key)) {
				continue
			}

			commands.push([
				"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
				[entry.key, new Uint8Array(pack([...entry.map.entries()]))]
			])
		}

		this.dirty.clear()

		if (commands.length === 0) {
			return
		}

		console.log(`[Cache] Persisting ${commands.length} dirty maps to disk`)

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
				const entries = await sqlite.kvAsync.get<[string, unknown][]>(key)

				if (!entries) {
					return
				}

				for (const [k, v] of entries) {
					Map.prototype.set.call(map, k, v)
				}
			})
		)

		for (let i = 0; i < results.length; i++) {
			const result = results[i] as PromiseSettledResult<void>

			if (result.status === "rejected") {
				const { key } = this.registry[i] as MapEntry

				console.error(`[Cache] Failed to restore ${key}, clearing corrupted data`, result.reason)

				sqlite.kvAsync.remove(key).catch(removeErr => {
					console.error(`[Cache] Failed to remove corrupted key ${key}`, removeErr)
				})
			}
		}

		for (const { map } of this.registry) {
			map.ready = true
		}

		AppState.addEventListener("change", state => {
			if (state === "background" || state === "inactive") {
				this.flush()
			}
		})
	}

	public flush(): void {
		this.schedulePersist.cancel()

		this.persistDirty()
	}

	public clear(): void {
		this.secureStore.clear()

		for (const { map } of this.registry) {
			Map.prototype.clear.call(map)
		}

		this.schedulePersist.cancel()

		this.dirty.clear()

		for (const { key } of this.registry) {
			sqlite.kvAsync.remove(key).catch(err => {
				console.error(`[Cache] Failed to remove ${key}`, err)
			})
		}
	}
}

const cache = new Cache()

export default cache
