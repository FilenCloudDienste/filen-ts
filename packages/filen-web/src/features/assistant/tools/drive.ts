import { driveItemName, fastLocaleCompare, formatBytes } from "@filen/shared"
import { looksLikeText } from "@filen/shared/textEncoding"
import {
	ASSISTANT_OFFICE_DOCUMENT_EXTENSIONS,
	DIRECTORIES_BY_SIZE_NOTE,
	listingOffset,
	listingPage,
	listRest,
	type AssistantSignal
} from "@filen/shared/assistant"
import type { DirSizeResponse } from "@filen/sdk-rs"
import type { ItemInfoResult } from "@/workers/sdk.worker"
import { log } from "@/lib/log"
import { queryClient } from "@/queries/client"
import {
	cachedListing,
	directorySizeQueryKey,
	directorySizeQueryOptions,
	fetchItemInfo,
	itemInfoQueryKey,
	type DirectorySizeItem
} from "@/features/drive/queries/drive"
import { asDirectoryOrFile, driveItemMime, isDirectoryItem, lastModifiedOf, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { CATEGORY_POLICY, extensionOf, itemTypeExtension, previewType } from "@/features/drive/lib/preview.logic"
import { defaultRevealDeps, resolveContainingDirectoryTarget } from "@/features/drive/lib/reveal"
import { searchDriveOnce, type DriveSearchOnceResult } from "@/features/drive/lib/searchQuery"
import { WATCHDOG_MS } from "@/features/drive/lib/searchStatus.logic"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { spreadsheetFileKind } from "@/features/spreadsheet/lib/fileKind"
import { loadDriveFileBytes } from "@/features/preview/lib/fileBytes"
import { readTextFile } from "@/features/preview/lib/textFile"
import { assistantRouter, navigateChecked } from "@/features/assistant/tools/navigation"
import { navigateToRoute } from "@/features/assistant/tools/routes"
import {
	abortSignalOf,
	ancestorsStillAt,
	cachedDriveRows,
	driveKind,
	driveName,
	freshDriveItem,
	joinPath,
	livePath,
	optionalString,
	readDriveListing,
	readSharedInListing,
	requiredString,
	resolveDrivePath,
	resolveHandle,
	rootDirUuid,
	shareDirection,
	sharedByOf,
	showDrive,
	type ToolAdapter,
	type ToolScope
} from "@/features/assistant/tools/entities"
import {
	AssistantToolError,
	clipText,
	engineTokens,
	isoDate,
	matchScore,
	normalizeText,
	rawSearchTokens,
	searchTokens,
	throwIfStopped
} from "@/features/assistant/tools/format"
import { ROOT_HANDLE, type AssistantEntity } from "@/features/assistant/tools/handles"
import { dateSelection, datesField, emptyDatesNote, selects, type DateSelection } from "@/features/assistant/tools/dates"

const SEARCH_LIMIT = 12
// How long a turn's searches may wait for the drive's index in all: a first index of a very large drive
// takes minutes, and the step shows the progress meanwhile. Stop ends it at once.
export const SEARCH_CAP_MS = 300_000
// A search once the turn's budget is spent still reads what the index already holds.
const SEARCH_FLOOR_MS = 2_000
// A resync silent this long ends the wait: as long as the search box's own watchdog, since a long apply
// reports nothing and the messages are lossy.
const SEARCH_STALL_MS = WATCHDOG_MS
// The engine keeps the drive registered this long after a search, so a follow-up costs no new resync.
const SEARCH_KEEP_MS = 10 * 60_000
// The words the engine may try in turn while one matches more names than its window holds.
const ENGINE_WORDS = 3
// read_text_file downloads the whole file, so only small ones; the model sees far less of it.
export const TEXT_FILE_MAX_BYTES = 1_048_576n
export const TEXT_FILE_MAX_CHARS = 4_000

export const DRIVE_DATE_FIELDS = ["modified", "uploaded", "created"] as const

export function matchesKind(item: DriveItem, kind: string | undefined): boolean {
	if (kind === undefined || kind === "any") {
		return true
	}

	if (kind === "directory" || kind === "file") {
		return driveKind(item) === kind
	}

	if (isDirectoryItem(item)) {
		return false
	}

	// Office files the app has no viewer for preview as "other": a document is one by its extension too.
	return (
		CATEGORY_POLICY[previewType(item)].assistantKind === kind ||
		(kind === "document" &&
			(ASSISTANT_OFFICE_DOCUMENT_EXTENSIONS.has(extensionOf(driveItemName(item))) ||
				ASSISTANT_OFFICE_DOCUMENT_EXTENSIONS.has(itemTypeExtension(item))))
	)
}

// The file's own creation date where the uploader recorded one, else when it reached the drive: what the info
// dialog shows as created.
export function createdOf(item: DriveItem): bigint {
	return asDirectoryOrFile(item).data.decryptedMeta?.created ?? item.data.timestamp
}

// "uploaded" is the server's own upload time; "modified" what the drive's Modified column shows.
export function driveDate(item: DriveItem, field: string): number {
	return Number(field === "uploaded" ? item.data.timestamp : field === "created" ? createdOf(item) : lastModifiedOf(item))
}

export function inDriveSelection(item: DriveItem, selection: DateSelection): boolean {
	return selects(selection, driveDate(item, selection.field))
}

export type ListingSort = "name" | "largest" | "smallest" | "newest" | "oldest"

const byItemName = (a: DriveItem, b: DriveItem) => fastLocaleCompare(driveItemName(a), driveItemName(b))

function byKey(key: (item: DriveItem) => number, ascending: boolean): (a: DriveItem, b: DriveItem) => number {
	return (a, b) => (ascending ? key(a) - key(b) : key(b) - key(a)) || byItemName(a, b)
}

// A size order ranks files and directories together, a directory by its total size (`directorySizes`), and
// puts directories of unknown size last by name: ranked as empty they would read as the smallest. A date
// order lists files first, since a directory's dates are when it was made.
export function sortListing(
	items: readonly DriveItem[],
	sort: ListingSort,
	field: string,
	directorySizes: ReadonlyMap<string, number> = new Map()
): DriveItem[] {
	if (sort === "name") {
		return items.toSorted((a, b) => Number(isDirectoryItem(b)) - Number(isDirectoryItem(a)) || byItemName(a, b))
	}

	if (sort === "largest" || sort === "smallest") {
		const size = (item: DriveItem) => (isDirectoryItem(item) ? directorySizes.get(item.data.uuid) : Number(item.data.size))
		const unknown = items.filter(item => size(item) === undefined)

		return [
			...items.filter(item => size(item) !== undefined).sort(byKey(item => size(item) ?? 0, sort === "smallest")),
			...unknown.sort(byItemName)
		]
	}

	const order = byKey(item => driveDate(item, field), sort === "oldest")

	return [...items.filter(item => !isDirectoryItem(item)).sort(order), ...items.filter(item => isDirectoryItem(item)).sort(order)]
}

// How many directories of a size-sorted listing may have their size read when the cache lacks it: each is a
// server-side walk of the directory. The info dialog's query, so the drive's size column reuses them.
export const DIRECTORY_SIZE_READS = 12

// The total sizes of the listing's directories, from the cache or read once (with `read`); `unknown` counts
// those left out.
export async function directorySizes(
	items: readonly DriveItem[],
	{ read: reads }: { read: boolean } = { read: true }
): Promise<{ sizes: Map<string, number>; unknown: number }> {
	const sizes = new Map<string, number>()
	const missing: DirectorySizeItem[] = []
	let unknown = 0

	for (const item of items) {
		if (!isDirectoryItem(item)) {
			continue
		}

		const cached = queryClient.getQueryData<DirSizeResponse>(directorySizeQueryKey(item.data.uuid))

		if (cached !== undefined) {
			sizes.set(item.data.uuid, Number(cached.size))
		} else if (reads && missing.length < DIRECTORY_SIZE_READS) {
			missing.push(item)
		} else {
			unknown++
		}
	}

	const read = await Promise.all(
		missing.map(item =>
			queryClient.query(directorySizeQueryOptions(item)).then(
				result => Number(result.size),
				() => undefined
			)
		)
	)

	missing.forEach((item, index) => {
		const size = read[index]

		if (size === undefined) {
			unknown++
		} else {
			sizes.set(item.data.uuid, size)
		}
	})

	return { sizes, unknown }
}

export function joinNotes(...notes: { note?: string }[]): { note?: string } {
	const text = notes.flatMap(({ note }) => (note === undefined ? [] : [note])).join(" ")

	return text.length === 0 ? {} : { note: text }
}

export function unknownSizesNote(unknown: number): { note?: string } {
	return unknown === 0
		? {}
		: {
				note:
					unknown === 1
						? "1 directory's size is not loaded; it is listed last. get_item_info gives a directory's size."
						: `${String(unknown)} directories' sizes are not loaded; they are listed last. get_item_info gives a directory's size.`
			}
}

// What a filtered or sorted listing adds to each row: the date it went by, the size it sorted by.
export function listingFields(
	item: DriveItem,
	{ date, size, directorySizes: known }: { date: string | null; size: boolean; directorySizes?: ReadonlyMap<string, number> }
): Record<string, string> {
	const fields: Record<string, string> = {}

	if (date !== null) {
		fields[date] = isoDate(driveDate(item, date))
	}

	if (size) {
		const bytes = isDirectoryItem(item) ? known?.get(item.data.uuid) : Number(item.data.size)

		if (bytes !== undefined) {
			fields["size"] = formatBytes(bytes)
		}
	}

	return fields
}

function hitPath(parentPath: string | undefined, name: string): string {
	const parent = (parentPath ?? "").replace(/^\/+|\/+$/g, "")

	return parent === "" ? `/${name}` : `/${parent}/${name}`
}

function engineItemType(kind: string | undefined): "all" | "file" | "dir" {
	return kind === undefined ? "all" : kind === "directory" ? "dir" : "file"
}

// Each turn's deadline: a model retrying other words would otherwise wait out the same index build again
// on every step, holding the loaded model all along.
const turnDeadlines = new WeakMap<AssistantSignal, number>()

function searchBudget(signal: AssistantSignal | undefined): number {
	const now = Date.now()

	if (signal === undefined) {
		return SEARCH_CAP_MS
	}

	let deadline = turnDeadlines.get(signal)

	if (deadline === undefined) {
		deadline = now + SEARCH_CAP_MS
		turnDeadlines.set(signal, deadline)
	}

	return Math.max(SEARCH_FLOOR_MS, deadline - now)
}

// The engine's hits for the most selective of `words`; null when the engine failed.
async function engineSearch(words: readonly string[], kind: string | undefined, scope: ToolScope): Promise<DriveSearchOnceResult | null> {
	const { progress } = scope
	const result = await searchDriveOnce(words, {
		capMs: searchBudget(scope.signal),
		stallMs: SEARCH_STALL_MS,
		keepMs: SEARCH_KEEP_MS,
		signal: abortSignalOf(scope.signal),
		itemType: engineItemType(kind),
		onProgress:
			progress === undefined
				? undefined
				: ({ indexed, candidates }) => {
						progress({ share: indexed, found: Number(candidates) })
					}
	}).catch((e: unknown) => {
		if (scope.signal?.aborted !== true) {
			log.warn("assistant", "drive search failed", e)
		}

		return null
	})

	throwIfStopped(scope)

	return result
}

// The engine returns a window of its hits: more than that means some were never seen.
function truncated(result: DriveSearchOnceResult): boolean {
	return result.total > BigInt(result.items.length)
}

function searchNote(engine: DriveSearchOnceResult | null): string | null {
	if (engine === null) {
		return "The drive search failed, so only the directories already loaded were searched; more matches may exist."
	}

	if (!engine.settled) {
		return "The drive's search index is still being built, so only part of the drive was searched; more matches may exist. The user can ask again in a few minutes."
	}

	if (truncated(engine)) {
		return `Too many names match: ${String(engine.total)} names contain "${engine.name}" and only the first ${String(engine.items.length)} were checked, so matches are likely missing. Ask the user for more specific words from the name.`
	}

	return null
}

// One engine handle of its own beside the user's search, so the user's search box is never disturbed;
// while the index converges, the listings the drive has already loaded too. Words are matched one by one,
// so "invoice 2024" finds "Invoice_2024_03.pdf": the engine is asked for the most selective word as
// written (it folds case only), and for the next ones while a word matches more names than it returns.
export const searchItemsTool: ToolAdapter = async (input, scope) => {
	const kind = optionalString(input, "kind")
	const query = requiredString(input, "query")
	const selection = dateSelection(input, DRIVE_DATE_FIELDS, scope.calendar)
	const tokens = searchTokens(query)
	const words = engineTokens(rawSearchTokens(query), ENGINE_WORDS)

	if (words.length === 0 || tokens.length === 0) {
		throw new AssistantToolError("Pass words from the item name", { invalid: true })
	}

	const engine = await engineSearch(words, kind, scope)
	const pool = new Map<string, { item: DriveItem; path: string | undefined }>()

	for (const item of engine?.items ?? []) {
		pool.set(item.data.uuid, { item, path: hitPath(engine?.parentPaths.get(item.data.uuid), driveItemName(item)) })
	}

	// An index that found nothing while a loaded listing holds a match is behind, not right.
	if (engine?.settled !== true || engine.items.length === 0) {
		for (const row of cachedDriveRows(item => matchScore(driveItemName(item), tokens) > 0)) {
			if (!pool.has(row.item.data.uuid)) {
				pool.set(row.item.data.uuid, row)
			}
		}
	}

	const wanted = normalizeText(query.trim())
	const matching = [...pool.values()]
		.filter(({ item }) => !item.data.undecryptable && matchesKind(item, kind))
		.map(row => ({ ...row, score: matchScore(driveItemName(row.item), tokens) }))
		.filter(({ score }) => score > 0)
	const scored = matching.filter(({ item }) => inDriveSelection(item, selection))
	const all = scored.filter(({ score }) => score === tokens.length)
	// The exact name first, then the shortest names (the fewest extra words), then the newest.
	const ranked = (all.length > 0 ? all : scored)
		.toSorted(
			(a, b) =>
				b.score - a.score ||
				Number(normalizeText(driveItemName(b.item)) === wanted) - Number(normalizeText(driveItemName(a.item)) === wanted) ||
				driveItemName(a.item).length - driveItemName(b.item).length ||
				Number(lastModifiedOf(b.item) - lastModifiedOf(a.item))
		)
		.slice(0, SEARCH_LIMIT)
	const shown = all.length > 0 ? all.length : scored.length
	const note = searchNote(engine)
	const partial = all.length === 0 && scored.length > 0 && tokens.length > 1

	return {
		value: {
			results: ranked.map(({ item, path }) => ({
				handle: showDrive(scope, item, path),
				name: driveName(item),
				kind: driveKind(item),
				...(path === undefined ? {} : { path }),
				...listingFields(item, { date: selection.range === null ? null : selection.field, size: false })
			})),
			// Incomplete (a failed search, an index still building, too many names to check): cut off at an
			// unknown length, which is what `more: true` says.
			...(note !== null ? { more: true } : listRest(shown, SEARCH_LIMIT)),
			...datesField(selection),
			...joinNotes(
				note === null ? emptyDatesNote(selection, scored.length, matching.length) : { note },
				partial ? { note: "No name contains all of the words; these contain only some of them." } : {}
			)
		}
	}
}

// Item-info entries read this page, by uuid: the entry is persisted, and a move keeps the uuid it is keyed
// by, so one restored from disk may name where the item used to be.
const infoReadThisPage = new Set<string>()

// The path the info dialog's Location row reads, from the same item-info query: read again once a page, as
// the dialog does (its staleTime is 0), then from the cache while the cached listings still show the item
// under the directories the entry names (nothing updates the entry on a rename or a move).
async function itemInfo(item: DriveItem): Promise<ItemInfoResult> {
	const base = asDirectoryOrFile(item)
	const queryKey = itemInfoQueryKey(base.data.uuid)
	const cached = queryClient.getQueryData<ItemInfoResult>(queryKey)
	const current =
		infoReadThisPage.has(base.data.uuid) &&
		cached !== undefined &&
		(cached.ancestors.at(-1)?.uuid ?? rootDirUuid()) === base.data.parent &&
		(cached.path === null || ancestorsStillAt(infoPath(cached, item), base.data.parent))
	const info = await queryClient.query({
		queryKey,
		queryFn: () => fetchItemInfo(base.data),
		staleTime: current ? "static" : 0
	})

	infoReadThisPage.add(base.data.uuid)

	return info
}

function infoPath(info: ItemInfoResult, item: DriveItem): string {
	return joinPath(
		info.ancestors.reduce((path, ancestor) => joinPath(path, driveItemName(narrowItem(ancestor))), "/"),
		driveItemName(item)
	)
}

async function itemPath(item: DriveItem): Promise<string | undefined> {
	const info = await itemInfo(item)

	return info.path === null ? undefined : infoPath(info, item)
}

// An item's parent directories below the root, nearest first, from the same item-info entry; undefined when
// it has no location (a trashed item) or the read failed.
export async function itemAncestors(item: DriveItem): Promise<DriveItem[] | undefined> {
	const info = await itemInfo(item).catch(() => undefined)

	return info?.path == null ? undefined : info.ancestors.map(ancestor => narrowItem(ancestor)).toReversed()
}

function pathField(path: string | undefined): { path?: string } {
	return path === undefined ? {} : { path }
}

export function isTrashed(item: DriveItem): boolean {
	return cachedListing("trash", null)?.some(row => row.data.uuid === item.data.uuid) ?? false
}

async function directoryEntity(input: Record<string, unknown>, scope: ToolScope): Promise<AssistantEntity> {
	const handle = optionalString(input, "handle")
	// Models fill both optional fields or put a path into "handle"; a path wins, being unambiguous. One that names
	// nothing (a guess beside a valid handle, e.g. a shared directory's name as a path) leaves the handle to decide.
	const path = optionalString(input, "path") ?? (handle?.trim().startsWith("/") === true ? handle : undefined)
	const byHandle = handle !== undefined && !handle.trim().startsWith("/")

	if (path !== undefined) {
		return byHandle
			? resolveDrivePath(path).catch((e: unknown) => {
					if (!(e instanceof AssistantToolError)) {
						throw e
					}

					return resolveHandle(scope, handle, ["root", "drive"])
				})
			: resolveDrivePath(path)
	}

	return handle === undefined ? { kind: "root" } : resolveHandle(scope, handle, ["root", "drive"])
}

export const listDirectoryTool: ToolAdapter = async (input, scope) => {
	const selection = dateSelection(input, DRIVE_DATE_FIELDS, scope.calendar)
	const kind = optionalString(input, "kind")
	// The loop validated it against the enum.
	const sort = (optionalString(input, "sort") ?? "name") as ListingSort
	const entity = await directoryEntity(input, scope)
	let uuid: string | null = null
	let directory: { handle: string; path: string | undefined; sharedBy?: string } = { handle: ROOT_HANDLE, path: "/" }
	// The uuid chain of a directory someone else shares, which lists through the Shared with me screen's query.
	let shared: readonly string[] | null = null

	if (entity.kind === "drive") {
		const item = freshDriveItem(entity.item)

		if (!isDirectoryItem(item)) {
			throw new AssistantToolError(`"${driveName(item)}" is a file, not a directory`, { invalid: true })
		}

		if (item.data.undecryptable) {
			throw new AssistantToolError("This directory cannot be decrypted")
		}

		uuid = item.data.uuid

		// One the user shares out is their own and lists like any other.
		if (shareDirection(item) === "in") {
			shared = entity.shared ?? [item.data.uuid]
			directory = { handle: scope.show({ kind: "drive", item, shared }, driveName(item)), path: undefined, ...sharedByOf(item) }
		} else {
			const path = livePath(entity, item) ?? (await itemPath(item).catch(() => undefined))

			directory = { handle: showDrive(scope, item, path), path }
		}
	} else {
		scope.show({ kind: "root" }, "/")
	}

	const listing = shared === null ? await readDriveListing(uuid) : await readSharedInListing(uuid, shared)

	throwIfStopped(scope)

	const ofKind = listing.filter(item => matchesKind(item, kind))
	const kept = ofKind.filter(item => inDriveSelection(item, selection))
	const byDate = selection.range !== null || sort === "newest" || sort === "oldest"
	const bySize = sort === "largest" || sort === "smallest"
	// A later page reads no new sizes: the first one cached its reads, so every page sorts on the same sizes.
	const sizes = bySize
		? await directorySizes(kept, { read: listingOffset(input["offset"]) === 0 })
		: { sizes: new Map<string, number>(), unknown: 0 }

	throwIfStopped(scope)

	const items = sortListing(kept, sort, selection.field, sizes.sizes)
	const page = listingPage(items, input["offset"], { filtered: kept.length < listing.length })

	return {
		value: {
			directory,
			...(page.offset > 0 ? { offset: page.offset } : {}),
			items: page.rows.map(item => ({
				handle:
					shared !== null && isDirectoryItem(item)
						? scope.show({ kind: "drive", item, shared: [...shared, item.data.uuid] }, driveName(item))
						: showDrive(scope, item, directory.path === undefined ? undefined : joinPath(directory.path, driveItemName(item))),
				name: driveName(item),
				kind: driveKind(item),
				...listingFields(item, { date: byDate ? selection.field : null, size: bySize, directorySizes: sizes.sizes })
			})),
			...(page.shown === undefined ? {} : { shown: page.shown }),
			...(page.more > 0 ? { more: page.more, next: page.next } : {}),
			...datesField(selection),
			...joinNotes(
				emptyDatesNote(selection, items.length, ofKind.length),
				page.note === undefined ? {} : { note: page.note },
				unknownSizesNote(sizes.unknown),
				bySize && items.some(isDirectoryItem) ? { note: DIRECTORIES_BY_SIZE_NOTE } : {}
			)
		}
	}
}

const OWN_SHARING_UNCHECKED = "unknown: this tool does not show shares or links"

export const getItemInfoTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["root", "drive"])

	if (entity.kind !== "drive") {
		return { value: { handle: scope.show(entity, "/"), name: "/", kind: "directory", path: "/" } }
	}

	const item = freshDriveItem(entity.item)

	if (item.data.undecryptable) {
		throw new AssistantToolError("This item cannot be decrypted")
	}

	// Like the info dialog, a trashed item gets no remote rows: its ancestry has nothing to walk.
	const trashed = isTrashed(item)
	const path = livePath(entity, item) ?? (trashed ? undefined : await itemPath(item).catch(() => undefined))
	let size: string | undefined = isDirectoryItem(item) ? undefined : formatBytes(Number(item.data.size))

	if (isDirectoryItem(item) && !trashed) {
		const totals = await queryClient.query(directorySizeQueryOptions(item)).catch(() => undefined)

		size =
			totals === undefined
				? undefined
				: `${formatBytes(Number(totals.size))} in ${String(totals.files)} files and ${String(totals.dirs)} directories`
	}

	const mime = driveItemMime(item)
	const created = isoDate(createdOf(item))
	const modified = isoDate(lastModifiedOf(item))
	// Only what the row itself says: an owned item's outgoing shares and links would cost a request each, so
	// they are marked unchecked (get_sharing reads them); left out, a model reports "not shared".
	const sharedWithYou = shareDirection(item) === "in"

	return {
		value: {
			handle: showDrive(scope, item, path),
			name: driveName(item),
			kind: driveKind(item),
			...(path === undefined ? {} : { path }),
			...(size === undefined ? {} : { size }),
			// The uploader's own MIME type: untrusted text, under a key the loop sanitizes.
			...(mime === undefined || mime === "" ? {} : { mime }),
			// One date where both fall on the same day: a second one only invites a small model to compare them.
			...(created === modified ? {} : { created }),
			modified,
			favorite: item.data.favorited,
			...(sharedWithYou ? { sharedWithYou: true, ...sharedByOf(item) } : { sharing: OWN_SHARING_UNCHECKED }),
			...(trashed ? { trashed: true } : {})
		}
	}
}

export const readTextFileTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["drive"])

	if (entity.kind !== "drive") {
		throw new AssistantToolError("Not a file", { invalid: true })
	}

	const item = freshDriveItem(entity.item)
	const name = driveName(item)

	if (isDirectoryItem(item)) {
		throw new AssistantToolError(`"${name}" is a directory, not a file`, { invalid: true })
	}

	if (item.data.undecryptable) {
		throw new AssistantToolError("This file cannot be decrypted")
	}

	const csv = spreadsheetFileKind(extensionOf(name).toLowerCase())

	// CSV and TSV preview as spreadsheets but are text.
	if (!CATEGORY_POLICY[previewType(item)].textFamily && csv !== "csv" && csv !== "tsv") {
		throw new AssistantToolError(`"${name}" is not a text file`)
	}

	if (item.data.size > TEXT_FILE_MAX_BYTES) {
		throw new AssistantToolError(`"${name}" is too large to read (${formatBytes(Number(item.data.size))})`)
	}

	const bytes = await loadDriveFileBytes(item, abortSignalOf(scope.signal))

	if (!looksLikeText(bytes)) {
		throw new AssistantToolError(`"${name}" is not a text file`)
	}

	const { text, truncated } = clipText(readTextFile(bytes).text, TEXT_FILE_MAX_CHARS)

	return {
		value: {
			handle: showDrive(scope, item, livePath(entity, item)),
			name,
			content: text,
			...(truncated ? { truncated: true } : {})
		}
	}
}

// A file: "Open containing directory", with the same resolver and armed reveal the item menu uses. One of the
// user's own directories opens itself, as a double click does. Nothing happens once the turn was stopped.
export const revealItemTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["root", "drive"])
	const router = assistantRouter()

	if (router === null) {
		throw new AssistantToolError("The app cannot navigate right now")
	}

	if (entity.kind !== "drive") {
		await navigateToRoute(router, "drive", scope.signal)

		return { value: { shown: "/" } }
	}

	const item = freshDriveItem(entity.item)
	const outcome = await resolveContainingDirectoryTarget(defaultRevealDeps, item)

	throwIfStopped(scope)

	if (outcome.status === "error") {
		throw new AssistantToolError(`Could not open the location of "${driveName(item)}"`)
	}

	const into = item.type === "directory" && !item.data.undecryptable
	const splat = into ? [outcome.target.params._splat, item.data.uuid].filter(part => part !== "").join("/") : outcome.target.params._splat
	const target = { ...outcome.target, params: { _splat: splat } }
	const pathname = target.to.replace("$", splat)

	if (!into) {
		useDriveStore.getState().requestReveal({ uuid: item.data.uuid, splat })
	}

	await navigateChecked({
		router,
		navigate: () => router.navigate(target),
		landed: current => current.replace(/\/+$/, "") === pathname.replace(/\/+$/, ""),
		signal: scope.signal
	})

	return {
		value: { [into ? "opened" : "shown"]: driveName(item), ...pathField(livePath(entity, item)) }
	}
}
