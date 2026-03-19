import { parseNumbersFromString } from "@filen/utils"
import type { DriveItem } from "@/types"
import type { Note, NoteTag } from "@filen/sdk-rs"
import type { ListItem as NoteListItem, Item as NoteItem } from "@/components/notes/note"

export type SortByType =
	| "nameAsc"
	| "sizeAsc"
	| "mimeAsc"
	| "lastModifiedAsc"
	| "nameDesc"
	| "sizeDesc"
	| "mimeDesc"
	| "lastModifiedDesc"
	| "uploadDateAsc"
	| "uploadDateDesc"
	| "creationAsc"
	| "creationDesc"

class ItemSorter {
	private uuidCache = new Map<string, number>()
	private lowerCache = new Map<string, string>()
	private numericPartsCache = new Map<string, (string | number)[]>()
	private readonly MAX_CACHE_SIZE = Infinity // Might adjust later if needed

	private getUuidNumber(uuid: string): number {
		let cached = this.uuidCache.get(uuid)

		if (!cached) {
			cached = parseNumbersFromString(uuid)

			this.uuidCache.set(uuid, cached)

			if (this.uuidCache.size > this.MAX_CACHE_SIZE) {
				this.uuidCache.clear()
			}
		}

		return cached
	}

	private getLowerName(name: string): string {
		let cached = this.lowerCache.get(name)

		if (!cached) {
			cached = name.toLowerCase()

			this.lowerCache.set(name, cached)

			if (this.lowerCache.size > this.MAX_CACHE_SIZE) {
				this.lowerCache.clear()
			}
		}

		return cached
	}

	private getNumericParts(str: string): (string | number)[] {
		let cached = this.numericPartsCache.get(str)

		if (!cached) {
			cached = []

			let currentNum = ""
			let currentText = ""

			for (let i = 0; i < str.length; i++) {
				const char = str[i]

				if (!char) {
					continue
				}

				const code = char.charCodeAt(0)

				if (code >= 48 && code <= 57) {
					if (currentText) {
						cached.push(currentText)

						currentText = ""
					}

					currentNum += char
				} else {
					if (currentNum) {
						cached.push(parseInt(currentNum, 10))

						currentNum = ""
					}

					currentText += char
				}
			}

			if (currentNum) {
				cached.push(parseInt(currentNum, 10))
			}

			if (currentText) {
				cached.push(currentText)
			}

			this.numericPartsCache.set(str, cached)

			if (this.numericPartsCache.size > this.MAX_CACHE_SIZE) {
				this.numericPartsCache.clear()
			}
		}

		return cached
	}

	private compareStringsNumeric(a: string, b: string): number {
		const aParts = this.getNumericParts(a)
		const bParts = this.getNumericParts(b)
		const minLen = Math.min(aParts.length, bParts.length)

		for (let i = 0; i < minLen; i++) {
			const aPart = aParts[i]
			const bPart = bParts[i]

			if (typeof aPart === "number" && typeof bPart === "number") {
				if (aPart !== bPart) {
					return aPart - bPart
				}
			} else if (typeof aPart === "string" && typeof bPart === "string") {
				if (aPart !== bPart) {
					return aPart < bPart ? -1 : 1
				}
			} else {
				return typeof aPart === "number" ? -1 : 1
			}
		}

		return aParts.length - bParts.length
	}

	private compareTypes(aType: string, bType: string): number {
		const aIsDir = aType === "directory" || aType === "sharedDirectory" || aType === "sharedRootDirectory"
		const bIsDir = bType === "directory" || bType === "sharedDirectory" || bType === "sharedRootDirectory"

		if (aIsDir && !bIsDir) {
			return -1
		}

		if (bIsDir && !aIsDir) {
			return 1
		}

		return 0
	}

	private compareName = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
		const typeComp = this.compareTypes(a.type, b.type)

		if (typeComp !== 0) {
			return typeComp
		}

		const aLower = this.getLowerName(a.data.decryptedMeta?.name ?? a.data.uuid)
		const bLower = this.getLowerName(b.data.decryptedMeta?.name ?? b.data.uuid)
		const result = this.compareStringsNumeric(aLower, bLower)

		return isAsc ? result : -result
	}

	private compareMime = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
		const typeComp = this.compareTypes(a.type, b.type)

		if (typeComp !== 0) {
			return typeComp
		}

		const aLower = this.getLowerName(
			a.type === "file"
				? (a.data.decryptedMeta?.mime ?? a.data.decryptedMeta?.name ?? a.data.uuid)
				: a.type === "sharedFile"
					? (a.data.decryptedMeta?.mime ?? a.data.decryptedMeta?.name ?? a.data.uuid)
					: (a.data.decryptedMeta?.name ?? a.data.uuid)
		)

		const bLower = this.getLowerName(
			b.type === "file"
				? (b.data.decryptedMeta?.mime ?? b.data.decryptedMeta?.name ?? b.data.uuid)
				: b.type === "sharedFile"
					? (b.data.decryptedMeta?.mime ?? b.data.decryptedMeta?.name ?? b.data.uuid)
					: (b.data.decryptedMeta?.name ?? b.data.uuid)
		)

		const result = this.compareStringsNumeric(aLower, bLower)

		return isAsc ? result : -result
	}

	private compareSize = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
		const typeComp = this.compareTypes(a.type, b.type)

		if (typeComp !== 0) {
			return typeComp
		}

		const cmp = a.data.size > b.data.size ? 1 : a.data.size < b.data.size ? -1 : 0

		return isAsc ? cmp : -cmp
	}

	private compareDate = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
		const typeComp = this.compareTypes(a.type, b.type)

		if (typeComp !== 0) {
			return typeComp
		}

		const aTimestamp = Number(
			a.type === "file"
				? a.data.timestamp
				: a.type === "directory"
					? a.data.timestamp
					: a.type === "sharedFile"
						? (a.data.decryptedMeta?.created ?? a.data.decryptedMeta?.modified ?? 0)
						: (a.data.decryptedMeta?.created ?? 0)
		)

		const bTimestamp = Number(
			b.type === "file"
				? b.data.timestamp
				: b.type === "directory"
					? b.data.timestamp
					: b.type === "sharedFile"
						? (b.data.decryptedMeta?.created ?? b.data.decryptedMeta?.modified ?? 0)
						: (b.data.decryptedMeta?.created ?? 0)
		)

		if (aTimestamp === bTimestamp) {
			const aUuid = this.getUuidNumber(a.data.uuid)
			const bUuid = this.getUuidNumber(b.data.uuid)
			const diff = aUuid - bUuid

			return isAsc ? diff : -diff
		}

		const diff = aTimestamp - bTimestamp

		return isAsc ? diff : -diff
	}

	private compareLastModified = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
		const typeComp = this.compareTypes(a.type, b.type)

		if (typeComp !== 0) {
			return typeComp
		}

		const aModified = Number(
			a.type === "file"
				? (a.data.decryptedMeta?.modified ?? a.data.timestamp)
				: a.type === "directory"
					? (a.data.decryptedMeta?.created ?? a.data.timestamp)
					: a.type === "sharedFile"
						? (a.data.decryptedMeta?.modified ?? a.data.decryptedMeta?.created ?? 0)
						: (a.data.decryptedMeta?.created ?? 0)
		)

		const bModified = Number(
			b.type === "file"
				? (b.data.decryptedMeta?.modified ?? b.data.timestamp)
				: b.type === "directory"
					? (b.data.decryptedMeta?.created ?? b.data.timestamp)
					: b.type === "sharedFile"
						? (b.data.decryptedMeta?.modified ?? b.data.decryptedMeta?.created ?? 0)
						: (b.data.decryptedMeta?.created ?? 0)
		)

		if (aModified === bModified) {
			const aUuid = this.getUuidNumber(a.data.uuid)
			const bUuid = this.getUuidNumber(b.data.uuid)
			const diff = aUuid - bUuid

			return isAsc ? diff : -diff
		}

		const diff = aModified - bModified

		return isAsc ? diff : -diff
	}

	private compareCreation = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
		const typeComp = this.compareTypes(a.type, b.type)

		if (typeComp !== 0) {
			return typeComp
		}

		const aTimestamp = Number(
			a.type === "file"
				? (a.data.decryptedMeta?.created ?? a.data.timestamp)
				: a.type === "directory"
					? (a.data.decryptedMeta?.created ?? a.data.timestamp)
					: a.type === "sharedFile"
						? (a.data.decryptedMeta?.created ?? a.data.decryptedMeta?.modified ?? 0)
						: (a.data.decryptedMeta?.created ?? 0)
		)

		const bTimestamp = Number(
			b.type === "file"
				? (b.data.decryptedMeta?.created ?? b.data.timestamp)
				: b.type === "directory"
					? (b.data.decryptedMeta?.created ?? b.data.timestamp)
					: b.type === "sharedFile"
						? (b.data.decryptedMeta?.created ?? b.data.decryptedMeta?.modified ?? 0)
						: (b.data.decryptedMeta?.created ?? 0)
		)

		if (aTimestamp === bTimestamp) {
			const aUuid = this.getUuidNumber(a.data.uuid)
			const bUuid = this.getUuidNumber(b.data.uuid)
			const diff = aUuid - bUuid

			return isAsc ? diff : -diff
		}

		const diff = aTimestamp - bTimestamp

		return isAsc ? diff : -diff
	}

	private readonly sortMap: Record<string, (a: DriveItem, b: DriveItem) => number> = {
		nameAsc: (a, b) => this.compareName(a, b, true),
		nameDesc: (a, b) => this.compareName(a, b, false),
		sizeAsc: (a, b) => this.compareSize(a, b, true),
		sizeDesc: (a, b) => this.compareSize(a, b, false),
		mimeAsc: (a, b) => this.compareMime(a, b, true),
		mimeDesc: (a, b) => this.compareMime(a, b, false),
		lastModifiedAsc: (a, b) => this.compareLastModified(a, b, true),
		lastModifiedDesc: (a, b) => this.compareLastModified(a, b, false),
		uploadDateAsc: (a, b) => this.compareDate(a, b, true),
		uploadDateDesc: (a, b) => this.compareDate(a, b, false),
		creationAsc: (a, b) => this.compareCreation(a, b, true),
		creationDesc: (a, b) => this.compareCreation(a, b, false)
	}

	public sortItems(items: DriveItem[], type: SortByType): DriveItem[] {
		const compareFunction = this.sortMap[type] ?? this.sortMap["nameAsc"]

		return items.slice().sort(compareFunction)
	}
}

export const itemSorter = new ItemSorter()

class NotesSorter {
	private readonly uuidCache: Map<string, number> = new Map()

	private parseUuid(uuid: string): number {
		const cached = this.uuidCache.get(uuid)

		if (cached) {
			return cached
		}

		const result = parseNumbersFromString(uuid)

		this.uuidCache.set(uuid, result)

		return result
	}

	public sort(
		notes: (
			| Note
			| (Note & {
					content?: string
			  })
		)[]
	): (
		| Note
		| (Note & {
				content?: string
		  })
	)[] {
		return notes.slice().sort((a, b) => {
			if (a.pinned !== b.pinned) {
				return b.pinned ? 1 : -1
			}

			if (a.trash !== b.trash && a.archive === false) {
				return a.trash ? 1 : -1
			}

			if (a.archive !== b.archive) {
				return a.archive ? 1 : -1
			}

			if (a.trash !== b.trash) {
				return a.trash ? 1 : -1
			}

			if (b.editedTimestamp === a.editedTimestamp) {
				return this.parseUuid(b.uuid) - this.parseUuid(a.uuid)
			}

			return Number(b.editedTimestamp) - Number(a.editedTimestamp)
		})
	}

	public group({
		notes,
		groupPinned,
		groupFavorited,
		groupArchived,
		groupTrashed,
		tag
	}: {
		notes: (
			| Note
			| (Note & {
					content?: string
			  })
		)[]
		groupPinned?: boolean
		groupFavorited?: boolean
		groupArchived?: boolean
		groupTrashed?: boolean
		tag?: NoteTag
	}): NoteListItem[] {
		if (tag) {
			notes = notes.filter(note => note.tags.some(t => t.uuid === tag.uuid))
		}

		const now = Date.now()
		const result: NoteListItem[] = []
		const todayMs = 24 * 60 * 60 * 1000
		const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
		const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
		const todayAgo = now - todayMs
		const sevenDaysAgo = now - sevenDaysMs
		const thirtyDaysAgo = now - thirtyDaysMs
		const nowDate = new Date(now)
		const currentYear = nowDate.getFullYear()
		const currentMonth = nowDate.getMonth()
		const oneMonthAgo = new Date(currentYear, currentMonth - 1, nowDate.getDate()).getTime()
		const twoMonthsAgo = new Date(currentYear, currentMonth - 2, nowDate.getDate()).getTime()
		const oneYearAgo = new Date(currentYear - 1, currentMonth, nowDate.getDate()).getTime()
		const today: NoteItem[] = []
		const last7Days: NoteItem[] = []
		const last30Days: NoteItem[] = []
		const previousMonth1: NoteItem[] = []
		const previousMonth2: NoteItem[] = []
		const trashed: NoteItem[] = []
		const archived: NoteItem[] = []
		const pinned: NoteItem[] = []
		const favorited: NoteItem[] = []
		const yearBuckets: {
			[year: number]: NoteItem[]
		} = {}

		const len = notes.length

		for (let i = 0; i < len; i++) {
			const note = notes[i]

			if (!note) {
				continue
			}

			if (groupTrashed && note.trash) {
				trashed.push(note)

				continue
			}

			if (groupArchived && note.archive) {
				archived.push(note)

				continue
			}

			if (groupPinned && note.pinned) {
				pinned.push(note)

				continue
			}

			if (groupFavorited && note.favorite) {
				favorited.push(note)

				continue
			}

			const editedTimestamp = Number(note.editedTimestamp ?? note.createdTimestamp)

			if (editedTimestamp >= todayAgo) {
				today.push(note)
			} else if (editedTimestamp >= sevenDaysAgo) {
				last7Days.push(note)
			} else if (editedTimestamp >= thirtyDaysAgo) {
				last30Days.push(note)
			} else if (editedTimestamp >= twoMonthsAgo) {
				previousMonth1.push(note)
			} else if (editedTimestamp >= oneYearAgo) {
				previousMonth2.push(note)
			} else {
				const year = new Date(editedTimestamp).getFullYear()

				if (!yearBuckets[year]) {
					yearBuckets[year] = []
				}

				yearBuckets[year].push(note)
			}
		}

		const sortDesc = (a: NoteItem, b: NoteItem) => {
			return Number(b.editedTimestamp ?? b.createdTimestamp) - Number(a.editedTimestamp ?? a.createdTimestamp)
		}

		if (groupPinned && pinned.length > 0) {
			pinned.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-pinned",
				title: "tbd_pinned"
			})

			for (let i = 0; i < pinned.length; i++) {
				const notes = pinned[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (groupFavorited && favorited.length > 0) {
			favorited.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-favorited",
				title: "tbd_favorited"
			})

			for (let i = 0; i < favorited.length; i++) {
				const notes = favorited[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (today.length > 0) {
			today.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-today",
				title: "tbd_today"
			})

			for (let i = 0; i < today.length; i++) {
				const notes = today[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (last7Days.length > 0) {
			last7Days.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-7days",
				title: "tbd_prev_7_days"
			})

			for (let i = 0; i < last7Days.length; i++) {
				const notes = last7Days[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (last30Days.length > 0) {
			last30Days.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-30days",
				title: "tbd_prev_30_days"
			})

			for (let i = 0; i < last30Days.length; i++) {
				const notes = last30Days[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (previousMonth1.length > 0) {
			previousMonth1.sort(sortDesc)

			const date = new Date(oneMonthAgo)

			result.push({
				type: "header",
				id: "header-month1",
				title: `tbd_month_${date.getMonth().toString()}`
			})

			for (let i = 0; i < previousMonth1.length; i++) {
				const notes = previousMonth1[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (previousMonth2.length > 0) {
			previousMonth2.sort(sortDesc)

			const date = new Date(twoMonthsAgo)

			result.push({
				type: "header",
				id: "header-month2",
				title: `tbd_month_${date.getMonth().toString()}`
			})

			for (let i = 0; i < previousMonth2.length; i++) {
				const notes = previousMonth2[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		const years = Object.keys(yearBuckets)
			.map(Number)
			.sort((a, b) => b - a)

		for (let i = 0; i < years.length; i++) {
			const year = years[i]

			if (!year) {
				continue
			}

			const yearNotes = yearBuckets[year]

			if (!yearNotes) {
				continue
			}

			yearNotes.sort(sortDesc)

			result.push({
				type: "header",
				id: `header-${year}`,
				title: year.toString()
			})

			for (let j = 0; j < yearNotes.length; j++) {
				const notes = yearNotes[j]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (archived.length > 0) {
			archived.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-archived",
				title: "tbd_archived"
			})

			for (let i = 0; i < archived.length; i++) {
				const notes = archived[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		if (trashed.length > 0) {
			trashed.sort(sortDesc)

			result.push({
				type: "header",
				id: "header-trashed",
				title: "tbd_trashed"
			})

			for (let i = 0; i < trashed.length; i++) {
				const notes = trashed[i]

				if (!notes) {
					continue
				}

				result.push({
					...notes,
					type: "note"
				})
			}
		}

		return result
	}
}

export const notesSorter = new NotesSorter()
