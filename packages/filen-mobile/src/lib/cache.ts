import type { Note, Chat, AnyNormalDir, AnySharedDirWithContext, AnyDirWithContext } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { debounce } from "es-toolkit"
import { pack, unpack } from "@/lib/msgpack"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { Platform } from "react-native"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"

const VERSION = 1
const PERSIST_DEBOUNCE_MS = 1000

/**
 * Map subclass that calls an onMutate callback on set/delete/clear.
 * Used with a shared debounced persist so any mutation schedules a single batched disk write.
 */
export class PersistentMap<V> extends Map<string, V> {
	private readonly onMutate: () => void

	public constructor(onMutate: () => void) {
		super()

		this.onMutate = onMutate
	}

	public override set(key: string, value: V): this {
		super.set(key, value)

		this.onMutate()

		return this
	}

	public override delete(key: string): boolean {
		const result = super.delete(key)

		if (result) {
			this.onMutate()
		}

		return result
	}

	public override clear(): void {
		if (this.size > 0) {
			super.clear()

			this.onMutate()
		}
	}
}

class Cache {
	private readonly file: FileSystem.File
	private readonly debouncedPersist: ReturnType<typeof debounce>
	private readonly directory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
				"cache"
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document.uri, "cache")
		})
	)

	// Not persisted — managed separately by secureStore.ts with its own encryption
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public readonly secureStore = new Map<string, any>()

	// Persisted — any PersistentMap field is auto-discovered by persist/restore
	public readonly directoryUuidToName: PersistentMap<string>
	public readonly noteUuidToNote: PersistentMap<Note>
	public readonly chatUuidToChat: PersistentMap<Chat>
	public readonly uuidToDriveItem: PersistentMap<DriveItem>
	public readonly directoryUuidToAnySharedDirWithContext: PersistentMap<AnySharedDirWithContext>
	public readonly directoryUuidToAnyNormalDir: PersistentMap<AnyNormalDir>
	public readonly directoryUuidToAnyDirWithContext: PersistentMap<AnyDirWithContext>

	public constructor() {
		if (!this.directory.exists) {
			this.directory.create({
				intermediates: true,
				idempotent: true
			})
		}

		this.file = new FileSystem.File(FileSystem.Paths.join(this.directory.uri, `cache.v${VERSION}.bin`))

		this.debouncedPersist = debounce(() => this.persist(), PERSIST_DEBOUNCE_MS, {
			edges: ["trailing"]
		})

		this.directoryUuidToName = this.createMap<string>()
		this.noteUuidToNote = this.createMap<Note>()
		this.chatUuidToChat = this.createMap<Chat>()
		this.uuidToDriveItem = this.createMap<DriveItem>()
		this.directoryUuidToAnySharedDirWithContext = this.createMap<AnySharedDirWithContext>()
		this.directoryUuidToAnyNormalDir = this.createMap<AnyNormalDir>()
		this.directoryUuidToAnyDirWithContext = this.createMap<AnyDirWithContext>()

		this.cleanupTmp()
	}

	private cleanupTmp(): void {
		if (!this.directory.exists) {
			return
		}

		const records = this.directory.list()

		for (const record of records) {
			if (!(record instanceof FileSystem.File) || !record.name.endsWith(".tmp") || !record.exists) {
				continue
			}

			record.delete()
		}
	}

	private createMap<V>(): PersistentMap<V> {
		return new PersistentMap<V>(() => {
			this.debouncedPersist()
		})
	}

	/**
	 * Populate maps from disk. Uses Map.prototype.set to bypass
	 * PersistentMap's onMutate and avoid a write-back cycle.
	 * Call during app setup before first render.
	 */
	public async restore(): Promise<void> {
		if (!this.file.exists) {
			return
		}

		const bytes = await this.file.bytes()

		if (bytes.length === 0) {
			return
		}

		const data = unpack(bytes) as Record<string, [string, unknown][]>

		for (const [key, entries] of Object.entries(data)) {
			const map = (this as Record<string, unknown>)[key]

			if (!(map instanceof PersistentMap) || !Array.isArray(entries)) {
				continue
			}

			for (const [k, v] of entries) {
				Map.prototype.set.call(map, k, v)
			}
		}
	}

	private persist(): void {
		const data: Record<string, [string, unknown][]> = {}

		for (const [key, value] of Object.entries(this)) {
			if (value instanceof PersistentMap) {
				data[key] = [...value.entries()]
			}
		}

		const tmp = new FileSystem.File(`${this.file.uri}.${randomUUID()}.tmp`)

		tmp.write(new Uint8Array(pack(data)))

		if (this.file.exists) {
			this.file.delete()
		}

		tmp.move(this.file)
	}

	public flush(): void {
		this.debouncedPersist.flush()
	}

	public clear(): void {
		this.debouncedPersist.cancel()
		this.secureStore.clear()

		for (const value of Object.values(this)) {
			if (value instanceof PersistentMap) {
				Map.prototype.clear.call(value)
			}
		}

		if (this.file.exists) {
			this.file.delete()
		}
	}
}

const cache = new Cache()

export default cache
