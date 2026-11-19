import {
	listRest,
	matchScore,
	MAX_ARRAY_ITEMS,
	ROOT_NOT_SHAREABLE,
	searchTokens,
	SHARED_WITH_YOU_NOTE,
	TRASH_NOTE,
	type ASSISTANT_DRIVE_SECTIONS
} from "@filen/shared/assistant"
import { queryClient } from "@/queries/client"
import type { QueryKey } from "@tanstack/react-query"
import {
	driveItemLinkStatusQueryOptions,
	driveListingQueryOptions,
	findCachedListingItem,
	type DriveItemLinkStatus
} from "@/features/drive/queries/drive"
import { getSharerIdentity, isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import {
	cachedDriveRows,
	driveKind,
	driveName,
	freshDriveItem,
	livePath,
	optionalString,
	readSharedInListing,
	readUnsyncedListing,
	requiredString,
	resolveHandle,
	rootDirUuid,
	shareDirection,
	sharedByOf,
	showDrive,
	UNSYNCED_LISTING_REUSE_MS,
	type ToolAdapter
} from "@/features/assistant/tools/entities"
import { AssistantToolError, throwIfStopped } from "@/features/assistant/tools/format"
import { isTrashed, itemAncestors, sortListing } from "@/features/assistant/tools/drive"

type DriveSection = (typeof ASSISTANT_DRIVE_SECTIONS)[number]

const SECTION_VARIANTS: Record<DriveSection, Exclude<DriveVariant, "drive" | "recents">> = {
	favorites: "favorites",
	trash: "trash",
	shared_with_me: "sharedIn",
	shared_by_me: "sharedOut",
	public_links: "links"
}

// Shared-out rows come one per recipient: each item once, with every address it is shared with.
function groupByItem(rows: readonly DriveItem[]): { item: DriveItem; with: string[] }[] {
	const byUuid = new Map<string, { item: DriveItem; with: string[] }>()

	for (const row of rows) {
		const entry = byUuid.get(row.data.uuid) ?? { item: row, with: [] }
		const email = getSharerIdentity(row)?.email

		if (email !== undefined && !entry.with.includes(email)) {
			entry.with.push(email)
		}

		byUuid.set(row.data.uuid, entry)
	}

	return [...byUuid.values()]
}

// The drive's own lists through their screens' queries, read again only once a minute. Rows show what the
// screens show beside the name: who shared an item, or with whom. The trash only lists: nothing here restores.
export const listSectionTool: ToolAdapter = async (input, scope) => {
	const section = requiredString(input, "section") as DriveSection
	const variant = SECTION_VARIANTS[section]
	const rows = (variant === "sharedIn" ? await readSharedInListing(null) : await readUnsyncedListing(variant)).filter(
		item => !item.data.undecryptable
	)

	throwIfStopped(scope)

	const tokens = searchTokens(optionalString(input, "query") ?? "")
	// A long trash or shared list is cut at the cap, so a question about one item narrows it first.
	const grouped = (variant === "sharedOut" ? groupByItem(rows) : rows.map(item => ({ item, with: [] }))).filter(
		({ item, with: recipients }) =>
			tokens.length === 0 ||
			matchScore([driveName(item), sharedByOf(item).sharedBy ?? "", ...recipients].join(" "), tokens) === tokens.length
	)
	const recipientsOf = new Map(grouped.map(entry => [entry.item.data.uuid, entry.with]))
	const sorted = sortListing(
		grouped.map(entry => entry.item),
		"name",
		"modified"
	)
	const shown = sorted.slice(0, MAX_ARRAY_ITEMS)
	// Favorites are the user's own items, so the cached My Drive listings may know where they are.
	const wanted = variant === "favorites" ? new Set(shown.map(item => item.data.uuid)) : new Set<string>()
	const paths = new Map<string, string | undefined>()

	if (wanted.size > 0) {
		for (const { item, path } of cachedDriveRows(row => wanted.has(row.data.uuid))) {
			paths.set(item.data.uuid, path)
		}
	}

	return {
		value: {
			section,
			items: shown.map(item => {
				const path = paths.get(item.data.uuid)
				const recipients = recipientsOf.get(item.data.uuid) ?? []

				return {
					handle:
						variant === "sharedIn" && isDirectoryItem(item)
							? scope.show({ kind: "drive", item, shared: [item.data.uuid] }, driveName(item))
							: showDrive(scope, item, path),
					name: driveName(item),
					kind: driveKind(item),
					...(path === undefined ? {} : { path }),
					...sharedByOf(item),
					...(recipients.length > 0 ? { sharedWith: recipients } : {})
				}
			}),
			...listRest(sorted.length),
			...(section === "trash" && sorted.length > 0 ? { note: TRASH_NOTE } : {})
		}
	}
}

// An item's parent directories, nearest first, from the My Drive listings already cached; undefined where one
// is not cached.
function cachedAncestors(item: DriveItem): DriveItem[] | undefined {
	const root = rootDirUuid()
	const ancestors: DriveItem[] = []
	const seen = new Set<string>([item.data.uuid])
	let parent = item.data.parent

	while (parent !== root) {
		if (seen.has(parent)) {
			return undefined
		}

		seen.add(parent)

		const row = findCachedListingItem(parent)

		if (row === undefined) {
			return undefined
		}

		ancestors.push(row)
		parent = row.data.parent
	}

	return ancestors
}

// The parents from the cached listings, else from the info dialog's own lookup. A trashed item has no
// location to walk (the lookup stalls on one).
async function ancestorsOf(item: DriveItem): Promise<DriveItem[] | undefined> {
	return cachedAncestors(item) ?? (isTrashed(item) ? undefined : itemAncestors(item))
}

// The SDK stores the lifetime chosen for the link, not a date: "7d" means seven days after it was set, which
// may already have passed.
function linkExpirySetting(expiration: string): string {
	return expiration === "never" ? "never" : `${expiration} after it was set`
}

function linkFields(status: DriveItemLinkStatus): { password: boolean; downloads: boolean; expirySetting: string } {
	return {
		password: status.status.password.type !== "none",
		downloads: status.type === "directory" ? status.status.enableDownload : status.status.downloadable,
		expirySetting: linkExpirySetting(status.status.expiration)
	}
}

// A query's data while it would not be read again, without a request; undefined when it would be.
function heldData<T>({ queryKey }: { queryKey: QueryKey; queryFn: () => Promise<T> }): { data: T } | undefined {
	const state = queryClient.getQueryState<T>(queryKey)

	if (state?.data === undefined || state.isInvalidated || Date.now() - state.dataUpdatedAt >= UNSYNCED_LISTING_REUSE_MS) {
		return undefined
	}

	return { data: state.data }
}

async function linkStatus(item: DriveItem): Promise<DriveItemLinkStatus | null> {
	return queryClient.query({ ...driveItemLinkStatusQueryOptions(item), staleTime: UNSYNCED_LISTING_REUSE_MS })
}

// The item's own link and the parent whose link reaches it. The link panel's read for the item is held after the
// user changed a link (the Links listing is not patched); else the Links listing tells whether the item has one,
// so the item's status (password, downloads, expiry) is read only for a listed item. With no parent to inherit
// from and no listing held, the item's own status is the one read.
async function linkState(
	item: DriveItem,
	ancestors: Promise<DriveItem[] | undefined>
): Promise<{ status: DriveItemLinkStatus | null; linkedThrough?: DriveItem | undefined }> {
	const own = heldData(driveItemLinkStatusQueryOptions(item))
	const heldLinks = heldData(driveListingQueryOptions("links", null))?.data
	const parents = heldLinks === undefined ? await ancestors : undefined

	if (heldLinks === undefined && (parents === undefined || parents.length === 0)) {
		return { status: own === undefined ? await linkStatus(item) : own.data }
	}

	const linked = new Set((heldLinks ?? (await readUnsyncedListing("links"))).map(row => row.data.uuid))
	const status = own !== undefined ? own.data : linked.has(item.data.uuid) ? await linkStatus(item) : null

	if (status !== null) {
		return { status }
	}

	return { status, linkedThrough: (parents ?? (await ancestors))?.find(ancestor => linked.has(ancestor.data.uuid)) }
}

// The link state above, the Shared by me listing for the item's own shares and what it inherits from a parent
// directory, and the info dialog's lookup only where no cached listing knows the parents: each read reused for a
// minute.
export const getSharingTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["root", "drive"])

	if (entity.kind !== "drive") {
		throw new AssistantToolError(ROOT_NOT_SHAREABLE)
	}

	const item = freshDriveItem(entity.item)

	if (item.data.undecryptable) {
		throw new AssistantToolError("This item cannot be decrypted")
	}

	const handle = showDrive(scope, item, livePath(entity, item))
	const name = driveName(item)

	if (shareDirection(item) === "in") {
		return { value: { handle, name, sharedWithYou: true, ...sharedByOf(item), note: SHARED_WITH_YOU_NOTE } }
	}

	const parents = ancestorsOf(item)
	const [{ status, linkedThrough }, sharedOut, ancestors] = await Promise.all([
		linkState(item, parents),
		readUnsyncedListing("sharedOut"),
		parents
	])

	throwIfStopped(scope)

	const shares = new Map(groupByItem(sharedOut).map(entry => [entry.item.data.uuid, entry.with]))
	const sharedThrough = ancestors?.find(ancestor => (shares.get(ancestor.data.uuid)?.length ?? 0) > 0)
	const sharedWith = shares.get(item.data.uuid) ?? []

	return {
		value: {
			handle,
			name,
			publicLink: status === null ? "none" : linkFields(status),
			...(linkedThrough === undefined ? {} : { linkedThrough: driveName(linkedThrough) }),
			sharedWith,
			...(sharedThrough === undefined
				? {}
				: { sharedThrough: { directory: driveName(sharedThrough), with: shares.get(sharedThrough.data.uuid) ?? [] } }),
			...(ancestors === undefined
				? { note: "Its parent directories are not loaded, so links and shares through them were not checked." }
				: {})
		}
	}
}
