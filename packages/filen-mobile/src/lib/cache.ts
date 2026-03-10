import type { Note, Chat, AnyNormalDir, AnySharedDirWithContext, AnyDirWithContext } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { debounce } from "es-toolkit"
import sqlite from "@/lib/sqlite"

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
	debouncedPersist: ReturnType<typeof debounce>
}

class Cache {
	private readonly registry: MapEntry[] = []

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

	public constructor() {
		this.directoryUuidToName = this.createMap<string>("directoryUuidToName")
		this.noteUuidToNote = this.createMap<Note>("noteUuidToNote")
		this.chatUuidToChat = this.createMap<Chat>("chatUuidToChat")
		this.uuidToDriveItem = this.createMap<DriveItem>("uuidToDriveItem")
		this.directoryUuidToAnySharedDirWithContext = this.createMap<AnySharedDirWithContext>(
			"directoryUuidToAnySharedDirWithContext"
		)
		this.directoryUuidToAnyNormalDir = this.createMap<AnyNormalDir>("directoryUuidToAnyNormalDir")
		this.directoryUuidToAnyDirWithContext = this.createMap<AnyDirWithContext>("directoryUuidToAnyDirWithContext")
	}

	private createMap<V>(name: string): PersistentMap<V> {
		const key = `cache:v${VERSION}:${name}`

		const map = new PersistentMap<V>(() => {
			debouncedPersist()
		})

		const debouncedPersist = debounce(
			() => {
				sqlite.kvAsync.set(key, [...map.entries()]).catch(err => {
					console.error(`[Cache] Failed to persist ${key}`, err)
				})
			},
			PERSIST_DEBOUNCE_MS,
			{
				edges: ["trailing"]
			}
		)

		this.registry.push({
			key,
			map: map as PersistentMap<unknown>,
			debouncedPersist
		})

		return map
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
	}

	public flush(): void {
		for (const { debouncedPersist } of this.registry) {
			debouncedPersist.flush()
		}
	}

	public clear(): void {
		for (const { debouncedPersist } of this.registry) {
			debouncedPersist.cancel()
		}

		this.secureStore.clear()

		for (const { map } of this.registry) {
			Map.prototype.clear.call(map)
		}

		for (const { key } of this.registry) {
			sqlite.kvAsync.remove(key).catch(err => {
				console.error(`[Cache] Failed to remove ${key}`, err)
			})
		}
	}
}

const cache = new Cache()

export default cache
