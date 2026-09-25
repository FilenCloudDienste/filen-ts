import { toast } from "sonner"
import { CancelledError } from "@tanstack/react-query"
import type { ParentUuid, SharingRole } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO, DIRECTORY_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { currentRootUuid } from "@/features/drive/lib/actions"
import {
	driveListingQueryKey,
	driveListingQueryOptions,
	flushListingCreates,
	normalizeParentUuid,
	type DriveListingParams
} from "@/features/drive/queries/drive"
import {
	clipboardGeneration,
	clipboardStamp,
	isClipboardCurrent,
	stableUuidOf,
	useDriveClipboardStore
} from "@/features/drive/store/useDriveClipboardStore"

// Events keep the clipboard on its items only while the socket stays up and delivers every drive event
// (clipboardSync.ts). After a gap, or when rows were copied from a listing that may be out of date, a paste
// first looks each item up again in the listing that holds it, read cache-first: a current one costs
// nothing, and any other the cache holds is read once, the read its next visit makes anyway. One the cache
// doesn't hold was never opened here and isn't read for this: its items paste as they are. Never a lookup
// per item, save a Shared by me root item its root no longer lists, looked up by itself and, for a file, in
// its directory's listing too. Nothing while the socket stays up.

// The other party's role: the receiver's for an item shared out, so the user owns it.
function sharedOut(role: SharingRole | undefined): boolean {
	return role !== undefined && "Receiver" in role
}

// A parent may name a flat view instead of a directory.
function parentListing(parent: ParentUuid, rootUuid: string): DriveListingParams {
	switch (parent) {
		case "trash":
		case "recents":
		case "favorites":
		case "links":
			return { variant: parent, uuid: null }
		default:
			return { variant: "drive", uuid: normalizeParentUuid(parent, rootUuid) }
	}
}

// Where the owner lists an item: its parent's listing, or for a root row of Shared by me, which carries no
// parent, the Shared by me root. undefined for an item shared with the user: no owner event reaches it
// either, so it stays as it is.
function homeListing(item: DriveItem, rootUuid: string): DriveListingParams | undefined {
	switch (item.type) {
		case "directory":
		case "file":
			return parentListing(item.data.parent, rootUuid)
		case "sharedDirectory":
		case "sharedFile":
			return sharedOut(item.data.sharingRole) ? parentListing(item.data.parent, rootUuid) : undefined
		case "sharedRootDirectory":
		case "sharedRootFile":
			return sharedOut(item.data.sharingRole) ? { variant: "sharedOut", uuid: null } : undefined
	}
}

function listingKey(params: DriveListingParams): string {
	return `${params.variant}:${params.uuid ?? ""}`
}

interface ListingRows {
	byUuid: Map<string, DriveItem>
	byStableUuid: Map<string, DriveItem>
}

function indexRows(rows: readonly DriveItem[]): ListingRows {
	const byUuid = new Map<string, DriveItem>()
	const byStableUuid = new Map<string, DriveItem>()

	for (const row of rows) {
		byUuid.set(row.data.uuid, row)

		const stableUuid = stableUuidOf(row)

		if (stableUuid !== undefined) {
			byStableUuid.set(stableUuid, row)
		}
	}

	return { byUuid, byStableUuid }
}

// `item` as its listing now holds it: by uuid, or a file's newer version by its stable id. null once it
// isn't there: moved elsewhere, trashed or deleted.
function currentRow(item: DriveItem, rows: ListingRows): DriveItem | null {
	const row = rows.byUuid.get(item.data.uuid)

	if (row !== undefined) {
		return row
	}

	const stableUuid = stableUuidOf(item)

	return (stableUuid === undefined ? undefined : rows.byStableUuid.get(stableUuid)) ?? null
}

// A Shared by me root item its root no longer lists was unshared, trashed or deleted, which only the item
// itself tells apart: as its owner now has it, or null once gone. A content save leaves a file's old uuid
// resolving as it was, so a file is taken as its directory's listing now holds it.
async function unlistedSharedRoot(
	item: DriveItem,
	rootUuid: string,
	rowsOf: (params: DriveListingParams) => Promise<ListingRows | null>
): Promise<DriveItem | null> {
	const uuid = item.data.uuid

	if (asDirectoryOrFile(item).type === "directory") {
		const dir = await sdkApi.getDirectory(uuid)

		return dir === undefined || dir.parent === "trash" ? null : narrowItem(dir)
	}

	const file = await sdkApi.getFile(uuid)

	if (file === undefined || file.parent === "trash") {
		return null
	}

	const rows = await rowsOf(parentListing(file.parent, rootUuid))

	return rows === null ? null : currentRow(narrowItem(file), rows)
}

interface CachedListing {
	// Every change since its read has reached its rows, so a read would answer from them.
	current: boolean
	byUuid: Map<string, DriveItem>
}

// A My Drive listing as the cache holds it, found by its key's hash: a filter find() re-hashes the whole
// query cache. undefined when it holds none.
function cachedDriveListing(uuid: string | null): CachedListing | undefined {
	const options = driveListingQueryOptions("drive", uuid)
	const query = queryClient.getQueryCache().get<DriveItem[]>(queryClient.defaultQueryOptions(options).queryHash)
	const rows = query?.state.data

	if (query === undefined || rows === undefined) {
		return undefined
	}

	const byUuid = new Map<string, DriveItem>()

	for (const row of rows) {
		byUuid.set(row.data.uuid, row)
	}

	return { current: !query.isStaleByTime(options.staleTime({ queryKey: options.queryKey })), byUuid }
}

// The items a copy or cut holds: as their own My Drive listing now has them when it's current, since a
// selection may predate a change it has taken. `current` is false when a row was copied from its listing
// while that may be out of date (after a gap until its read lands, at boot until the first), or its
// current listing no longer has it: the paste looks those up first. Only My Drive's listings know whether
// they're current; an item from anywhere else is as current as that view.
export function asListed(items: readonly DriveItem[]): { items: DriveItem[]; current: boolean } {
	const rootUuid = currentRootUuid()
	const listings = new Map<string, CachedListing | undefined>()
	let current = true

	const listed = items.map(item => {
		if (item.type !== "directory" && item.type !== "file") {
			return item
		}

		const home = parentListing(item.data.parent, rootUuid)

		if (home.variant !== "drive") {
			return item
		}

		const key = listingKey(home)
		let listing = listings.get(key)

		if (!listings.has(key)) {
			listing = cachedDriveListing(home.uuid)
			listings.set(key, listing)
		}

		const row = listing?.byUuid.get(item.data.uuid)

		if (listing?.current === true) {
			if (row === undefined) {
				current = false

				return item
			}

			return row
		}

		if (row === item) {
			current = false
		}

		return item
	})

	return { items: listed, current }
}

// A trashed directory can't be listed, and a deleted one no longer resolves.
function isDirectoryGone(dto: ErrorDTO): boolean {
	return dto.kind === "FolderNotFound" || (dto.species === "plain" && dto.message.startsWith(DIRECTORY_NOT_FOUND_PREFIX))
}

// A reconnect's refetch silently cancels a read under way to start its own, and query-core moves only the
// cancelled read's starter on to the new one: a lookup that joined it asks again, which joins the new read.
const MAX_REJOINS = 3

async function readRows(params: DriveListingParams, rejoins = 0): Promise<DriveItem[]> {
	try {
		return await queryClient.query(driveListingQueryOptions(params.variant, params.uuid))
	} catch (e) {
		if (e instanceof CancelledError && e.silent === true && rejoins < MAX_REJOINS) {
			return readRows(params, rejoins + 1)
		}

		throw e
	}
}

// A listing's rows, read cache-first. null once its directory is gone, and with it everything it held.
async function listingRows(params: DriveListingParams): Promise<ListingRows | null> {
	try {
		return indexRows(await readRows(params))
	} catch (e) {
		if (isDirectoryGone(asErrorDTO(e))) {
			return null
		}

		throw e
	}
}

// The paste is refused over a lookup that failed. A read cancelled for good, as logout cancels them, is no
// error to show.
function refuse(e: unknown): false {
	if (!(e instanceof CancelledError)) {
		toast.error(errorLabel(asErrorDTO(e)))
	}

	return false
}

// Brings the clipboard's items up to date before a paste. false when a listing couldn't be read, or when
// something else was copied or cut meanwhile: the paste is refused rather than acting on items that may be
// stale, or that it wasn't asked for.
export async function recheckClipboard(): Promise<boolean> {
	const entry = useDriveClipboardStore.getState().entry

	if (entry === null || isClipboardCurrent()) {
		return true
	}

	// Taken before the reads: an event landing during them still reaches the items, and a gap during them
	// makes the next paste look again.
	const checked = clipboardStamp()
	const generation = clipboardGeneration()
	const rootUuid = currentRootUuid()
	const listings = new Map<string, ListingRows | null>()
	const reads = new Map<string, Promise<ListingRows | null>>()
	// Each listing read once. A file created moments ago joins its listing first, so a content save's
	// successor is found there.
	const rowsOf = (params: DriveListingParams): Promise<ListingRows | null> => {
		const key = listingKey(params)
		let read = reads.get(key)

		if (read === undefined) {
			flushListingCreates()
			read = listingRows(params).then(rows => {
				listings.set(key, rows)

				return rows
			})
			reads.set(key, read)
		}

		return read
	}
	const homes = new Map<DriveItem, string>()

	for (const item of entry.items) {
		const home = homeListing(item, rootUuid)

		if (home === undefined || queryClient.getQueryData(driveListingQueryKey(home)) === undefined) {
			continue
		}

		void rowsOf(home)
		homes.set(item, listingKey(home))
	}

	try {
		await Promise.all(reads.values())
	} catch (e) {
		return refuse(e)
	}

	const found = new Map<DriveItem, DriveItem | null>()
	const unlisted: DriveItem[] = []

	for (const [item, key] of homes) {
		const rows = listings.get(key)

		if (rows === undefined) {
			continue
		}

		const row = rows === null ? null : currentRow(item, rows)

		if (row === null && (item.type === "sharedRootDirectory" || item.type === "sharedRootFile")) {
			unlisted.push(item)
		} else {
			found.set(item, row)
		}
	}

	// Not for an entry the user has already replaced.
	if (unlisted.length > 0 && clipboardGeneration() === generation) {
		try {
			await Promise.all(
				unlisted.map(async item => {
					found.set(item, await unlistedSharedRoot(item, rootUuid, rowsOf))
				})
			)
		} catch (e) {
			return refuse(e)
		}
	}

	const gone = useDriveClipboardStore.getState().applyRecheck(found, checked, generation)

	if (gone === null) {
		return false
	}

	if (gone > 0) {
		toast.warning(i18n.t("drive:driveClipboardItemsGoneToast", { count: gone }))
	}

	return true
}
