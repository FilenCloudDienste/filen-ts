import type { Dir } from "@filen/sdk-rs"
import { previewType } from "@/features/drive/lib/preview.logic"
import { captureTimestamp, type PhotoItem } from "@/features/photos/lib/captureSort"

// Client-side search over what a photos listing already holds: file name, the folder path under the
// root, and the capture date. Nothing is fetched to search — content and EXIF would mean downloading
// every file.

export type PhotoKind = "image" | "rawImage" | "video"
export type PhotosKindFilter = "all" | PhotoKind

export interface PhotosFilter {
	query: string
	kind: PhotosKindFilter
	favoritesOnly: boolean
}

export const EMPTY_PHOTOS_FILTER: PhotosFilter = { query: "", kind: "all", favoritesOnly: false }

export function isPhotosFilterActive(filter: PhotosFilter): boolean {
	return filter.query.trim().length > 0 || filter.kind !== "all" || filter.favoritesOnly
}

// Case- and accent-insensitive: "cafe" finds "Café".
export function normalizeSearchText(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
}

// Each directory under the root that directly holds a photo, mapped to its path below the root
// ("Italy 2023/Rome"). Only those are kept: the listing persists, and the rest would never be read.
export function photoFolderPaths(dirs: readonly Dir[], photos: readonly PhotoItem[], rootUuid: string): Record<string, string> {
	const byUuid = new Map<string, Dir>()

	for (const dir of dirs) {
		byUuid.set(dir.uuid, dir)
	}

	const resolved = new Map<string, string>()

	const pathOf = (uuid: string): string => {
		const known = resolved.get(uuid)

		if (known !== undefined) {
			return known
		}

		// Walked iteratively: a deep tree must not grow the stack, and a parent cycle must not hang.
		const chain: Dir[] = []
		const seen = new Set<string>()
		let cursor = byUuid.get(uuid)

		while (cursor !== undefined && cursor.uuid !== rootUuid && !seen.has(cursor.uuid) && !resolved.has(cursor.uuid)) {
			seen.add(cursor.uuid)
			chain.push(cursor)
			cursor = byUuid.get(cursor.parent)
		}

		let path = cursor === undefined ? "" : (resolved.get(cursor.uuid) ?? "")

		for (let index = chain.length - 1; index >= 0; index--) {
			const dir = chain[index]

			if (dir === undefined) {
				continue
			}

			const name = dir.meta.type === "decoded" ? dir.meta.data.name : ""

			path = path.length > 0 ? `${path}/${name}` : name
			resolved.set(dir.uuid, path)
		}

		return resolved.get(uuid) ?? ""
	}

	const out: Record<string, string> = {}

	for (const photo of photos) {
		const parent = photo.data.parent

		if (parent === rootUuid || parent in out || !byUuid.has(parent)) {
			continue
		}

		out[parent] = pathOf(parent)
	}

	return out
}

export interface PhotoSearchEntry {
	// Normalized "name\nfolder path", searched by substring.
	text: string
	year: number
	// 0-11
	month: number
	day: number
	kind: PhotoKind
}

// Per item object: a favorite or rename patch replaces only the photos it touches, so the rest keep
// their entries. A folder rename re-walks the listing, which replaces every item anyway.
const entryCache = new WeakMap<PhotoItem, PhotoSearchEntry>()

export function photoSearchEntry(item: PhotoItem, folders: Readonly<Record<string, string>>): PhotoSearchEntry {
	const cached = entryCache.get(item)

	if (cached !== undefined) {
		return cached
	}

	const date = new Date(captureTimestamp(item))
	const category = previewType(item)
	const entry: PhotoSearchEntry = {
		text: normalizeSearchText(`${item.data.decryptedMeta?.name ?? ""}\n${folders[item.data.parent] ?? ""}`),
		year: date.getFullYear(),
		month: date.getMonth(),
		day: date.getDate(),
		kind: category === "video" ? "video" : category === "rawImage" ? "rawImage" : "image"
	}

	entryCache.set(item, entry)

	return entry
}

// One query word. It matches a photo when its text occurs in the name or folder path, or when the
// photo's capture date agrees with every date part the word names: "2023", "july", "15", "2023-07".
export interface PhotosQueryToken {
	text: string
	year?: number
	month?: number
	day?: number
}

// Normalized month name -> 0-11, in the UI language plus English, long and short forms.
export type MonthNameTable = ReadonlyMap<string, number>

const monthTables = new Map<string, MonthNameTable>()

export function monthNameTable(locale: string): MonthNameTable {
	const cached = monthTables.get(locale)

	if (cached !== undefined) {
		return cached
	}

	const table = new Map<string, number>()

	for (const tableLocale of locale === "en" ? ["en"] : [locale, "en"]) {
		for (const style of ["long", "short"] as const) {
			let format: Intl.DateTimeFormat

			try {
				format = new Intl.DateTimeFormat(tableLocale, { month: style, timeZone: "UTC" })
			} catch {
				continue
			}

			for (let month = 0; month < 12; month++) {
				const name = normalizeSearchText(format.format(Date.UTC(2000, month, 15))).replace(/\.$/, "")

				if (!table.has(name)) {
					table.set(name, month)
				}
			}
		}
	}

	monthTables.set(locale, table)

	return table
}

// Shortest prefix of a long month name that still reads as one ("sept", "janu").
const MONTH_PREFIX_MIN = 3

function monthOf(word: string, months: MonthNameTable): number | undefined {
	const exact = months.get(word)

	if (exact !== undefined || word.length < MONTH_PREFIX_MIN || /\d/.test(word)) {
		return exact
	}

	let found: number | undefined

	for (const [name, month] of months) {
		if (name.startsWith(word)) {
			// A prefix two months share names neither.
			if (found !== undefined && found !== month) {
				return undefined
			}

			found = month
		}
	}

	return found
}

const MIN_YEAR = 1900
const MAX_YEAR = 2199

export function parsePhotosQuery(query: string, months: MonthNameTable): PhotosQueryToken[] {
	const tokens: PhotosQueryToken[] = []

	for (const raw of normalizeSearchText(query).split(/\s+/)) {
		// "July 15, 2024": separators trailing a word are punctuation, not part of what is searched.
		const word = raw.replace(/[,;]+$/, "")

		if (word.length === 0) {
			continue
		}

		const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(word)

		if (iso !== null) {
			const year = Number(iso[1])
			const month = Number(iso[2]) - 1
			const day = iso[3] === undefined ? undefined : Number(iso[3])

			tokens.push({ text: word, year, month, ...(day === undefined ? {} : { day }) })

			continue
		}

		if (/^\d{4}$/.test(word)) {
			const year = Number(word)

			tokens.push(year >= MIN_YEAR && year <= MAX_YEAR ? { text: word, year } : { text: word })

			continue
		}

		if (/^\d{1,2}$/.test(word)) {
			const day = Number(word)

			tokens.push(day >= 1 && day <= 31 ? { text: word, day } : { text: word })

			continue
		}

		const month = monthOf(word, months)

		tokens.push(month === undefined ? { text: word } : { text: word, month })
	}

	return tokens
}

function tokenMatches(token: PhotosQueryToken, entry: PhotoSearchEntry): boolean {
	if (entry.text.includes(token.text)) {
		return true
	}

	if (token.year === undefined && token.month === undefined && token.day === undefined) {
		return false
	}

	return (
		(token.year === undefined || token.year === entry.year) &&
		(token.month === undefined || token.month === entry.month) &&
		(token.day === undefined || token.day === entry.day)
	)
}

export interface FilteredPhotos {
	items: PhotoItem[]
	entries: PhotoSearchEntry[]
}

// Every word must match (AND), as must the kind and favorites filters. Order is kept.
export function filterPhotos(
	photos: PhotoItem[],
	folders: Readonly<Record<string, string>>,
	filter: PhotosFilter,
	months: MonthNameTable
): FilteredPhotos {
	const tokens = parsePhotosQuery(filter.query, months)
	const items: PhotoItem[] = []
	const entries: PhotoSearchEntry[] = []

	for (const photo of photos) {
		if (filter.favoritesOnly && !photo.data.favorited) {
			continue
		}

		const entry = photoSearchEntry(photo, folders)

		if (filter.kind !== "all" && entry.kind !== filter.kind) {
			continue
		}

		if (tokens.every(token => tokenMatches(token, entry))) {
			items.push(photo)
			entries.push(entry)
		}
	}

	return { items: items.length === photos.length ? photos : items, entries }
}

// Which kinds the listing holds at all, so the screen offers only chips that can narrow something.
export function photoKindsPresent(photos: readonly PhotoItem[], folders: Readonly<Record<string, string>>): ReadonlySet<PhotoKind> {
	const kinds = new Set<PhotoKind>()

	for (const photo of photos) {
		kinds.add(photoSearchEntry(photo, folders).kind)

		if (kinds.size === 3) {
			break
		}
	}

	return kinds
}
