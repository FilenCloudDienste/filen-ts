/**
 * In-memory mock of expo-media-library/next for Vitest.
 *
 * 1:1 mock of the real expo-media-library/next API, backed by an in-memory
 * Map of assets and albums. All classes, enums, types, and functions that
 * exist on the real module are implemented here.
 *
 * Usage in test files:
 *
 *   vi.mock("expo-media-library/next", async () => await import("@/tests/mocks/expoMediaLibrary"))
 *
 *   import { ml } from "@/tests/mocks/expoMediaLibrary"
 *
 *   beforeEach(() => ml.clear())
 *
 *   ml.addAsset({ id: "asset-1", filename: "photo.jpg", uri: "file:///photo.jpg", mediaType: MediaType.IMAGE })
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type GranularPermission = "audio" | "photo" | "video"

export type Shape = {
	width: number
	height: number
}

export type Location = {
	latitude: number
	longitude: number
}

export type SortDescriptor = {
	key: AssetField
	ascending?: boolean
}

export type AssetInfo = {
	id: string
	filename: string
	uri: string
	mediaType: MediaType
	width: number
	height: number
	duration: number | null
	creationTime: number | null
	modificationTime: number | null
}

// ─── Enums ──────────────────────────────────────────────────────────────────

export enum MediaType {
	UNKNOWN = "unknown",
	IMAGE = "image",
	AUDIO = "audio",
	VIDEO = "video"
}

export enum AssetField {
	CREATION_TIME = "creationTime",
	MODIFICATION_TIME = "modificationTime",
	MEDIA_TYPE = "mediaType",
	WIDTH = "width",
	HEIGHT = "height",
	DURATION = "duration"
}

export type AssetFieldValueMap = {
	[AssetField.CREATION_TIME]: number
	[AssetField.MODIFICATION_TIME]: number
	[AssetField.MEDIA_TYPE]: MediaType
	[AssetField.WIDTH]: number
	[AssetField.HEIGHT]: number
	[AssetField.DURATION]: number
}

// ─── Internal backing store ─────────────────────────────────────────────────

type StoredAsset = {
	id: string
	filename: string
	uri: string
	mediaType: MediaType
	width: number
	height: number
	duration: number | null
	creationTime: number | null
	modificationTime: number | null
	location: Location | null
	exif: Record<string, unknown>
}

type StoredAlbum = {
	id: string
	title: string
	assetIds: string[]
}

class BackingStore {
	readonly assets = new Map<string, StoredAsset>()
	readonly albums = new Map<string, StoredAlbum>()

	addAsset(partial: Partial<StoredAsset> & { id: string }): Asset {
		const stored: StoredAsset = {
			filename: "IMG_0001.jpg",
			uri: `file:///media/${partial.id}`,
			mediaType: MediaType.IMAGE,
			width: 1920,
			height: 1080,
			duration: null,
			creationTime: Date.now(),
			modificationTime: Date.now(),
			location: null,
			exif: {},
			...partial
		}

		this.assets.set(stored.id, stored)

		return new Asset(stored.id)
	}

	addAlbum(partial: Partial<StoredAlbum> & { id: string }): Album {
		const stored: StoredAlbum = {
			title: "Camera Roll",
			assetIds: [],
			...partial
		}

		this.albums.set(stored.id, stored)

		return new Album(stored.id)
	}

	clear(): void {
		this.assets.clear()
		this.albums.clear()
	}
}

/** The backing store — shared singleton across all tests in the same file. */
export const ml = new BackingStore()

// ─── Asset ──────────────────────────────────────────────────────────────────

export class Asset {
	id: string

	constructor(id: string) {
		this.id = id
	}

	private get stored(): StoredAsset {
		const stored = ml.assets.get(this.id)

		if (!stored) {
			throw new Error(`Asset not found: ${this.id}`)
		}

		return stored
	}

	async getCreationTime(): Promise<number | null> {
		return this.stored.creationTime
	}

	async getDuration(): Promise<number | null> {
		return this.stored.duration
	}

	async getFilename(): Promise<string> {
		return this.stored.filename
	}

	async getHeight(): Promise<number> {
		return this.stored.height
	}

	async getMediaType(): Promise<MediaType> {
		return this.stored.mediaType
	}

	async getModificationTime(): Promise<number | null> {
		return this.stored.modificationTime
	}

	async getShape(): Promise<Shape | null> {
		return {
			width: this.stored.width,
			height: this.stored.height
		}
	}

	async getUri(): Promise<string> {
		return this.stored.uri
	}

	async getWidth(): Promise<number> {
		return this.stored.width
	}

	async getInfo(): Promise<AssetInfo> {
		const s = this.stored

		return {
			id: s.id,
			filename: s.filename,
			uri: s.uri,
			mediaType: s.mediaType,
			width: s.width,
			height: s.height,
			duration: s.duration,
			creationTime: s.creationTime,
			modificationTime: s.modificationTime
		}
	}

	async getLocation(): Promise<Location | null> {
		return this.stored.location
	}

	async getExif(): Promise<Record<string, unknown>> {
		return this.stored.exif
	}

	async delete(): Promise<void> {
		ml.assets.delete(this.id)
	}

	static async create(filePath: string, album?: Album): Promise<Asset> {
		const id = `asset-${ml.assets.size}`
		const filename = filePath.split("/").pop() ?? "unknown"
		const asset = ml.addAsset({
			id,
			filename,
			uri: filePath
		})

		if (album) {
			const stored = ml.albums.get(album.id)

			if (stored) {
				stored.assetIds.push(id)
			}
		}

		return asset
	}

	static async delete(assets: Asset[]): Promise<void> {
		for (const asset of assets) {
			ml.assets.delete(asset.id)
		}
	}
}

// ─── Album ──────────────────────────────────────────────────────────────────

export class Album {
	id: string

	constructor(id: string) {
		this.id = id
	}

	private get stored(): StoredAlbum {
		const stored = ml.albums.get(this.id)

		if (!stored) {
			throw new Error(`Album not found: ${this.id}`)
		}

		return stored
	}

	async getAssets(): Promise<Asset[]> {
		return this.stored.assetIds.filter(id => ml.assets.has(id)).map(id => new Asset(id))
	}

	async getTitle(): Promise<string> {
		return this.stored.title
	}

	async delete(): Promise<void> {
		ml.albums.delete(this.id)
	}

	async add(asset: Asset): Promise<void> {
		const stored = ml.albums.get(this.id)

		if (stored && !stored.assetIds.includes(asset.id)) {
			stored.assetIds.push(asset.id)
		}
	}

	static async create(name: string, assetsRefs: string[] | Asset[], _moveAssets: boolean = true): Promise<Album> {
		const id = `album-${ml.albums.size}`
		const assetIds = assetsRefs.map(ref => (typeof ref === "string" ? ref : ref.id))
		const album = ml.addAlbum({
			id,
			title: name,
			assetIds
		})

		return album
	}

	static async delete(albums: Album[], _deleteAssets: boolean = false): Promise<void> {
		for (const album of albums) {
			ml.albums.delete(album.id)
		}
	}

	static async get(title: string): Promise<Album | null> {
		for (const [, stored] of ml.albums) {
			if (stored.title === title) {
				return new Album(stored.id)
			}
		}

		return null
	}
}

// ─── Query ──────────────────────────────────────────────────────────────────

export class Query {
	private filters: ((asset: StoredAsset) => boolean)[] = []
	private sortDescriptors: SortDescriptor[] = []
	private limitValue: number | null = null
	private offsetValue: number = 0
	private albumFilter: Album | null = null

	eq<T extends AssetField>(field: T, value: AssetFieldValueMap[T]): Query {
		this.filters.push(asset => asset[field] === value)

		return this
	}

	within<T extends AssetField>(field: T, value: AssetFieldValueMap[T][]): Query {
		this.filters.push(asset => (value as unknown[]).includes(asset[field]))

		return this
	}

	gt(field: AssetField, value: number): Query {
		this.filters.push(asset => {
			const v = asset[field]

			return typeof v === "number" && v > value
		})

		return this
	}

	gte(field: AssetField, value: number): Query {
		this.filters.push(asset => {
			const v = asset[field]

			return typeof v === "number" && v >= value
		})

		return this
	}

	lt(field: AssetField, value: number): Query {
		this.filters.push(asset => {
			const v = asset[field]

			return typeof v === "number" && v < value
		})

		return this
	}

	lte(field: AssetField, value: number): Query {
		this.filters.push(asset => {
			const v = asset[field]

			return typeof v === "number" && v <= value
		})

		return this
	}

	limit(limit: number): Query {
		this.limitValue = limit

		return this
	}

	offset(offset: number): Query {
		this.offsetValue = offset

		return this
	}

	orderBy(sortDescriptors: SortDescriptor | AssetField): Query {
		if (typeof sortDescriptors === "string") {
			this.sortDescriptors.push({
				key: sortDescriptors,
				ascending: true
			})
		} else {
			this.sortDescriptors.push(sortDescriptors)
		}

		return this
	}

	album(album: Album): Query {
		this.albumFilter = album

		return this
	}

	async exe(): Promise<Asset[]> {
		let candidates: StoredAsset[]

		if (this.albumFilter) {
			const stored = ml.albums.get(this.albumFilter.id)
			const ids = stored ? stored.assetIds : []

			candidates = ids.map(id => ml.assets.get(id)).filter((a): a is StoredAsset => typeof a !== "undefined")
		} else {
			candidates = [...ml.assets.values()]
		}

		for (const filter of this.filters) {
			candidates = candidates.filter(filter)
		}

		for (const sort of this.sortDescriptors) {
			candidates.sort((a, b) => {
				const aVal = a[sort.key]
				const bVal = b[sort.key]

				if (aVal === null || typeof aVal === "undefined") {
					return 1
				}

				if (bVal === null || typeof bVal === "undefined") {
					return -1
				}

				if (typeof aVal === "number" && typeof bVal === "number") {
					return sort.ascending === false ? bVal - aVal : aVal - bVal
				}

				const aStr = String(aVal)
				const bStr = String(bVal)

				return sort.ascending === false ? bStr.localeCompare(aStr) : aStr.localeCompare(bStr)
			})
		}

		if (this.offsetValue > 0) {
			candidates = candidates.slice(this.offsetValue)
		}

		if (this.limitValue !== null) {
			candidates = candidates.slice(0, this.limitValue)
		}

		return candidates.map(a => new Asset(a.id))
	}
}

// ─── Permissions ────────────────────────────────────────────────────────────

export async function requestPermissionsAsync(
	_writeOnly: boolean = false,
	_granularPermissions?: GranularPermission[]
): Promise<{ status: string; granted: boolean; canAskAgain: boolean; expires: string }> {
	return {
		status: "granted",
		granted: true,
		canAskAgain: true,
		expires: "never"
	}
}
