import { parseNumbersFromString } from "@filen/utils"
import { type DriveItem, type Note, type NoteTag } from "@/types"
import type { ListItem as NoteListItem, Item as NoteItem } from "@/features/notes/components/note"
import i18n from "@/lib/i18n"
import { intlLanguage } from "@/lib/time"

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

const uuidCache = new Map<string, number>()
const lowerCache = new Map<string, string>()
const numericPartsCache = new Map<string, (string | number)[]>()
const MAX_CACHE_SIZE = Infinity // Might adjust later if needed

function getUuidNumber(uuid: string): number {
	let cached = uuidCache.get(uuid)

	if (cached === undefined) {
		cached = parseNumbersFromString(uuid)

		uuidCache.set(uuid, cached)

		if (uuidCache.size > MAX_CACHE_SIZE) {
			uuidCache.clear()
		}
	}

	return cached
}

function getLowerName(name: string): string {
	let cached = lowerCache.get(name)

	if (cached === undefined) {
		cached = name.toLowerCase()

		lowerCache.set(name, cached)

		if (lowerCache.size > MAX_CACHE_SIZE) {
			lowerCache.clear()
		}
	}

	return cached
}

function getNumericParts(str: string): (string | number)[] {
	let cached = numericPartsCache.get(str)

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

		numericPartsCache.set(str, cached)

		if (numericPartsCache.size > MAX_CACHE_SIZE) {
			numericPartsCache.clear()
		}
	}

	return cached
}

function compareStringsNumeric(a: string, b: string): number {
	const aParts = getNumericParts(a)
	const bParts = getNumericParts(b)
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

function compareTypes(aType: string, bType: string): number {
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

const compareName = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
	const typeComp = compareTypes(a.type, b.type)

	if (typeComp !== 0) {
		return typeComp
	}

	const aLower = getLowerName(a.data.decryptedMeta?.name ?? a.data.uuid)
	const bLower = getLowerName(b.data.decryptedMeta?.name ?? b.data.uuid)
	const result = compareStringsNumeric(aLower, bLower)

	return isAsc ? result : -result
}

const compareMime = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
	const typeComp = compareTypes(a.type, b.type)

	if (typeComp !== 0) {
		return typeComp
	}

	const aLower = getLowerName(
		a.type === "file"
			? (a.data.decryptedMeta?.mime ?? a.data.decryptedMeta?.name ?? a.data.uuid)
			: a.type === "sharedFile" || a.type === "sharedRootFile"
				? (a.data.decryptedMeta?.mime ?? a.data.decryptedMeta?.name ?? a.data.uuid)
				: (a.data.decryptedMeta?.name ?? a.data.uuid)
	)

	const bLower = getLowerName(
		b.type === "file"
			? (b.data.decryptedMeta?.mime ?? b.data.decryptedMeta?.name ?? b.data.uuid)
			: b.type === "sharedFile" || b.type === "sharedRootFile"
				? (b.data.decryptedMeta?.mime ?? b.data.decryptedMeta?.name ?? b.data.uuid)
				: (b.data.decryptedMeta?.name ?? b.data.uuid)
	)

	const result = compareStringsNumeric(aLower, bLower)

	return isAsc ? result : -result
}

const compareSize = (a: DriveItem, b: DriveItem, isAsc: boolean): number => {
	const typeComp = compareTypes(a.type, b.type)

	if (typeComp !== 0) {
		return typeComp
	}

	const cmp = a.data.size > b.data.size ? 1 : a.data.size < b.data.size ? -1 : 0

	return isAsc ? cmp : -cmp
}

// Shared skeleton for the timestamp-based comparators: dirs-before-files, then compare a
// per-mode extracted timestamp, with the numeric-uuid tiebreaker and asc/desc flip. Each
// mode only differs in how it reads the timestamp off an item — passed in as `getTimestamp`.
const compareByTimestamp = (
	a: DriveItem,
	b: DriveItem,
	isAsc: boolean,
	getTimestamp: (item: DriveItem) => number
): number => {
	const typeComp = compareTypes(a.type, b.type)

	if (typeComp !== 0) {
		return typeComp
	}

	const aTimestamp = getTimestamp(a)
	const bTimestamp = getTimestamp(b)

	if (aTimestamp === bTimestamp) {
		const diff = getUuidNumber(a.data.uuid) - getUuidNumber(b.data.uuid)

		return isAsc ? diff : -diff
	}

	const diff = aTimestamp - bTimestamp

	return isAsc ? diff : -diff
}

const compareDate = (a: DriveItem, b: DriveItem, isAsc: boolean): number =>
	compareByTimestamp(a, b, isAsc, item =>
		Number(
			item.type === "file"
				? item.data.timestamp
				: item.type === "directory"
					? item.data.timestamp
					: item.type === "sharedFile" || item.type === "sharedRootFile"
						? (item.data.decryptedMeta?.created ?? item.data.decryptedMeta?.modified ?? 0)
						: (item.data.decryptedMeta?.created ?? 0)
		)
	)

const compareLastModified = (a: DriveItem, b: DriveItem, isAsc: boolean): number =>
	compareByTimestamp(a, b, isAsc, item =>
		Number(
			item.type === "file"
				? (item.data.decryptedMeta?.modified ?? item.data.timestamp)
				: item.type === "directory"
					? (item.data.decryptedMeta?.created ?? item.data.timestamp)
					: item.type === "sharedFile" || item.type === "sharedRootFile"
						? (item.data.decryptedMeta?.modified ?? item.data.decryptedMeta?.created ?? 0)
						: (item.data.decryptedMeta?.created ?? 0)
		)
	)

const compareCreation = (a: DriveItem, b: DriveItem, isAsc: boolean): number =>
	compareByTimestamp(a, b, isAsc, item =>
		Number(
			item.type === "file"
				? (item.data.decryptedMeta?.created ?? item.data.timestamp)
				: item.type === "directory"
					? (item.data.decryptedMeta?.created ?? item.data.timestamp)
					: item.type === "sharedFile" || item.type === "sharedRootFile"
						? (item.data.decryptedMeta?.created ?? item.data.decryptedMeta?.modified ?? 0)
						: (item.data.decryptedMeta?.created ?? 0)
		)
	)

const sortMap: Record<string, (a: DriveItem, b: DriveItem) => number> = {
	nameAsc: (a, b) => compareName(a, b, true),
	nameDesc: (a, b) => compareName(a, b, false),
	sizeAsc: (a, b) => compareSize(a, b, true),
	sizeDesc: (a, b) => compareSize(a, b, false),
	mimeAsc: (a, b) => compareMime(a, b, true),
	mimeDesc: (a, b) => compareMime(a, b, false),
	lastModifiedAsc: (a, b) => compareLastModified(a, b, true),
	lastModifiedDesc: (a, b) => compareLastModified(a, b, false),
	uploadDateAsc: (a, b) => compareDate(a, b, true),
	uploadDateDesc: (a, b) => compareDate(a, b, false),
	creationAsc: (a, b) => compareCreation(a, b, true),
	creationDesc: (a, b) => compareCreation(a, b, false)
}

function sortItems(items: DriveItem[], type: SortByType): DriveItem[] {
	const compareFunction = sortMap[type] ?? sortMap["nameAsc"]

	return items.slice().sort(compareFunction)
}

export const itemSorter = { sortItems }

const notesUuidCache: Map<string, number> = new Map()

function parseUuid(uuid: string): number {
	const cached = notesUuidCache.get(uuid)

	if (cached !== undefined) {
		return cached
	}

	const result = parseNumbersFromString(uuid)

	notesUuidCache.set(uuid, result)

	return result
}

function sort(
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

		const tier = (note: { trash: boolean; archive: boolean }): number => (note.trash ? 2 : note.archive ? 1 : 0)
		const aTier = tier(a)
		const bTier = tier(b)

		if (aTier !== bTier) {
			return aTier - bTier
		}

		if (b.editedTimestamp === a.editedTimestamp) {
			return parseUuid(b.uuid) - parseUuid(a.uuid)
		}

		return Number(b.editedTimestamp) - Number(a.editedTimestamp)
	})
}

function group({
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
	const twoMonthsAgo = new Date(currentYear, currentMonth - 2, nowDate.getDate()).getTime()
	const today: NoteItem[] = []
	const last7Days: NoteItem[] = []
	const last30Days: NoteItem[] = []
	const previousMonth: NoteItem[] = []
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
			previousMonth.push(note)
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
			title: i18n.t("pinned"),
			icon: "pin-outline"
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
			title: i18n.t("favorited"),
			icon: "heart-outline"
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
			title: i18n.t("today"),
			icon: "today-outline"
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
			title: i18n.t("previous_7_days"),
			icon: "calendar-outline"
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
			title: i18n.t("previous_30_days"),
			icon: "calendar-outline"
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

	if (previousMonth.length > 0) {
		previousMonth.sort(sortDesc)

		const date = new Date(twoMonthsAgo)

		result.push({
			type: "header",
			id: "header-month",
			title: new Intl.DateTimeFormat(intlLanguage, {
				month: "long"
			}).format(date),
			icon: "calendar-outline"
		})

		for (let i = 0; i < previousMonth.length; i++) {
			const notes = previousMonth[i]

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

		if (year === undefined) {
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
			title: year.toString(),
			icon: "calendar-outline"
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
			title: i18n.t("archived"),
			icon: "archive-outline"
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
			title: i18n.t("trashed"),
			icon: "trash-outline"
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

export const notesSorter = { sort, group }
