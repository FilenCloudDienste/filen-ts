import { toast } from "sonner"
import { CancelledError } from "@tanstack/react-query"
import type { ParentUuid, SharingRole } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO, DIRECTORY_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"
import { queryClient } from "@/queries/client"
import type { DriveItem } from "@/features/drive/lib/item"
import { currentRootUuid } from "@/features/drive/lib/actions"
import {
	driveListingQueryKey,
	driveListingQueryOptions,
	flushListingCreates,
	normalizeParentUuid,
	type DriveListingParams
} from "@/features/drive/queries/drive"
import { clipboardStamp, isClipboardCurrent, stableUuidOf, useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

// Events keep the clipboard on its items only while the socket stays up and delivers every drive event
// (clipboardSync.ts). After a gap, or when rows were copied from a listing that may be out of date, a paste
// first looks each item up again in the listing that holds it, read cache-first: a current one costs
// nothing, and any other the cache holds is read once, the read its next visit makes anyway. One the cache
// doesn't hold was never opened here and isn't read for this: its items paste as they are. Never a lookup
// per item, and nothing while the socket stays up.

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

// Brings the clipboard's items up to date before a paste. false when a listing couldn't be read: the
// paste is refused rather than acting on items that may be stale.
export async function recheckClipboard(): Promise<boolean> {
	const entry = useDriveClipboardStore.getState().entry

	if (entry === null || isClipboardCurrent()) {
		return true
	}

	// Taken before the reads: an event landing during them still reaches the items, and a gap during them
	// makes the next paste look again.
	const checked = clipboardStamp()
	const rootUuid = currentRootUuid()
	// null once the listing's directory is gone, and with it everything it held.
	const listings = new Map<string, ListingRows | null>()
	const reads = new Map<string, Promise<void>>()
	const homes = new Map<DriveItem, string>()

	// A file created moments ago joins its listing first, so a content save's successor is found there.
	flushListingCreates()

	for (const item of entry.items) {
		const home = homeListing(item, rootUuid)

		if (home === undefined || queryClient.getQueryData(driveListingQueryKey(home)) === undefined) {
			continue
		}

		const key = listingKey(home)

		if (!reads.has(key)) {
			reads.set(
				key,
				readRows(home).then(
					rows => {
						listings.set(key, indexRows(rows))
					},
					(e: unknown) => {
						if (!isDirectoryGone(asErrorDTO(e))) {
							throw e
						}

						listings.set(key, null)
					}
				)
			)
		}

		homes.set(item, key)
	}

	try {
		await Promise.all(reads.values())
	} catch (e) {
		// A read cancelled for good, as logout cancels them, is no error to show.
		if (!(e instanceof CancelledError)) {
			toast.error(errorLabel(asErrorDTO(e)))
		}

		return false
	}

	const found = new Map<DriveItem, DriveItem | null>()

	for (const [item, key] of homes) {
		const rows = listings.get(key)

		if (rows !== undefined) {
			found.set(item, rows === null ? null : currentRow(item, rows))
		}
	}

	const gone = useDriveClipboardStore.getState().applyRecheck(found, checked)

	if (gone > 0) {
		toast.warning(i18n.t("drive:driveClipboardItemsGoneToast", { count: gone }))
	}

	return true
}
