import { useQueries, useQuery, type Query, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { cachedQueriesWithPrefix, cachedQuery, setQueryDataKeepInvalidated } from "@/queries/patch"
// Whole-statement `import type` here too — sdk.worker.ts's own top-level code pulls in
// @filen/sdk-rs as a real value import, same elision hazard as above.
import type { ListDirectoryTarget, ItemInfoResult } from "@/workers/sdk.worker"
import type {
	Dir,
	File,
	FileVersion,
	DirPublicLinkRW,
	FilePublicLink,
	DirColor,
	DirSizeResponse,
	GetItemPathResult,
	SharingRole
} from "@filen/sdk-rs"
import { fastLocaleCompare, driveItemName, removeByUuid, upsertItems } from "@filen/shared"
import {
	narrowItem,
	asDirectoryOrFile,
	isDirectoryItem,
	toAnyDirWithContext,
	type DriveItem,
	type DirectoryLikeItem
} from "@/features/drive/lib/item"
import type { FlatListingKind } from "@/features/drive/lib/flatListing"
import {
	getHideHiddenItems,
	getSortPreferences,
	getViewModePreferences,
	type DriveLocation,
	type DrivePreferences,
	type DriveVariant,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import { getHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"

// Query key taxonomy per client.ts ([domain, entity, params?]): `uuid` is null for every flat
// listing (recents/favorites/trash) and for My Drive's own root, so a fast nav between two
// directories only ever changes this one key's `uuid` — the rest of the shape is fixed per variant.
export type DriveListingParams = DriveLocation

// The prefix every listing scan and invalidation matches on.
export const DRIVE_LISTING_KEY_PREFIX = ["drive", "listing"] as const

export function driveListingQueryKey(params: DriveListingParams) {
	return [...DRIVE_LISTING_KEY_PREFIX, params] as const
}

// Root only applies to the "drive" variant (client.root() has no equivalent for the flat listings);
// recents/favorites/trash/links are always their own flat listing regardless of how the caller got
// there. The two shared variants list through their own worker ops (different result shapes — see
// fetchSharedListing), never listDirectory, so they have no target here.
export function toListingTarget(variant: DriveVariant, uuid: string | null): ListDirectoryTarget {
	switch (variant) {
		case "drive":
			return uuid === null ? { kind: "root" } : { kind: "uuid", uuid }
		case "recents":
		case "favorites":
		case "trash":
		case "links":
			return { kind: variant }
		case "sharedIn":
		case "sharedOut":
			throw new Error(`toListingTarget: shared variant "${variant}" lists via its own ops, not listDirectory`)
	}
}

// Plain, testable query function — mirrors fetchAccount (queries/account.ts): the hook itself is a
// one-line wrapper this project's node-environment unit tests can't exercise (no DOM renderer —
// see vitest.config.ts), so the fetch is exported and unit-tested against a mocked sdkApi instead.
export async function fetchDirectoryListing(variant: DriveVariant, uuid: string | null): Promise<DriveItem[]> {
	const { dirs, files } = await sdkApi.listDirectory(toListingTarget(variant, uuid))
	return [...dirs.map(narrowItem), ...files.map(narrowItem)]
}

// The variants socket events keep current: every change to one either arrives as an event that patches
// it in place or marks it stale (socketHandlers.ts). The rest change with no event, so they keep
// refetching: recents ages rows out by upload time, links and shares are made elsewhere silently, and
// the server purges trash 30 days after trashing with no event, while no row carries when it was trashed.
// Favorites follow trash: a favorite inside a trashed directory may stay listed until that purge.
const SOCKET_SYNCED_VARIANTS: ReadonlySet<DriveVariant> = new Set(["drive"])

function listingId(variant: DriveVariant, uuid: string | null): string {
	return `${variant}:${uuid ?? ""}`
}

// Listings whose latest read ran entirely under a live socket with no stale mark landing meanwhile, so
// every change since has reached their rows as an event. A persisted listing restores with its original
// read time, a read the socket wasn't up for may predate an event it never delivered, and a read a stale
// mark overlaps may predate the change behind it, so none of those count.
const listingsReadThisSession = new Set<string>()
let listingStaleMarks = 0

type ListingPatch = (items: DriveItem[]) => DriveItem[]

// A listing patch kept as data, so a read under way can fold a burst of them into one pass over what it
// returns (applyListingChanges).
export type ListingChange =
	| { type: "remove"; uuid: string }
	// Never adds a row.
	| { type: "replace"; uuid: string; replace: (row: DriveItem) => DriveItem }
	// A same-uuid or same-name row makes way (upsertItems).
	| { type: "upsert"; items: readonly DriveItem[] }
	// A same-uuid row makes way: rows of a flat listing may share a name.
	| { type: "append"; items: readonly DriveItem[] }
	| { type: "update"; update: ListingPatch }

// A change to one row wherever a listing holds it.
export type ListingRowChange = Extract<ListingChange, { type: "remove" | "replace" }>

// The listing reads under way, per listing, with the changes that landed meanwhile. A read may have
// snapshotted the server before the change behind one, so it applies the ones that landed after it began
// to what it returns: a change is never lost to an overlapping read, which therefore needs neither
// cancelling nor repeating. `marks` counts changes that couldn't carry their whole effect
// (markListingStale); one landing during a read keeps it from counting. `started` counts the reads
// begun: query-core begins one while another is under way only once it has dropped that one.
interface ListingReads {
	params: DriveListingParams
	running: number
	started: number
	changes: ListingChange[]
	marks: number
}

const listingReads = new Map<string, ListingReads>()

async function readApplyingPatches(
	params: DriveListingParams,
	read: () => Promise<DriveItem[]>
): Promise<{ items: DriveItem[]; marked: boolean; dropped: boolean }> {
	const id = listingId(params.variant, params.uuid)
	let reads = listingReads.get(id)

	if (reads === undefined) {
		reads = { params, running: 0, started: 0, changes: [], marks: 0 }

		listingReads.set(id, reads)
	}

	const from = reads.changes.length
	const marks = reads.marks

	reads.started++
	reads.running++

	const started = reads.started

	try {
		const items = await read()

		// The listing read never touches the abort signal: once read, it makes unmounting a listing mid-read
		// cancel the read, which the next mount then repeats. So a read an invalidation cancelled still gets
		// here, with a result query-core throws away.
		if (reads.started !== started) {
			return { items, marked: false, dropped: true }
		}

		return { items: applyListingChanges(items, reads.changes, from), marked: reads.marks !== marks, dropped: false }
	} finally {
		reads.running--

		if (reads.running === 0 && listingReads.get(id) === reads) {
			listingReads.delete(id)
		}
	}
}

async function readListing(variant: Exclude<DriveVariant, "sharedIn" | "sharedOut">, uuid: string | null): Promise<DriveItem[]> {
	const epoch = currentSocketEpoch()
	const marks = listingStaleMarks
	const { items, marked, dropped } = await readApplyingPatches({ variant, uuid }, () => fetchDirectoryListing(variant, uuid))

	// The read that replaced it records its own.
	if (dropped) {
		return items
	}

	const id = listingId(variant, uuid)

	if (socketLiveSince(epoch) && marks === listingStaleMarks && !marked) {
		listingsReadThisSession.add(id)
	} else {
		listingsReadThisSession.delete(id)
	}

	return items
}

// A read socket-synced listing changes only through writes and socket events that patch it in place, so
// it stays fresh until a socket drop or an unpatchable event marks it stale (socketHandlers.ts); the
// first mount after boot still reads. A network reconnect always re-reads: events may have been missed
// meanwhile. Both observers of a key take these together, since focus/reconnect refetch whenever any one
// observer asks.
const listingRefetchPolicy = {
	staleTime: (query: { queryKey: ReturnType<typeof driveListingQueryKey> }) => {
		const { variant, uuid } = query.queryKey[2]

		return SOCKET_SYNCED_VARIANTS.has(variant) && listingsReadThisSession.has(listingId(variant, uuid)) ? Infinity : 0
	},
	refetchOnReconnect: "always"
} as const

// dirs/files bigints (timestamp, size, chunks, meta created/modified/size) cross Comlink via
// structured clone already (see sdk.worker.ts); this module never JSON.stringifies them, and the
// result rides the persister's own envelope serializer at rest — zero customization needed here.
//
// One builder serves every variant — DirectoryListing is variant-generic, so rules-of-hooks forbid
// picking between two listing hooks per render. The queryFn dispatches instead: the two shared
// variants fetch through fetchSharedListing (whose worker ops return a different result shape than
// listDirectory — see fetchSharedListing / toListingTarget's throw), everything else through
// readListing. The guard narrows `variant` to the shared union, matching its param.
// `path` is a shared-variant resolution hint only (see fetchSharedListing) — deliberately NOT part of
// the query KEY: the same uuid lists the same contents however it was reached, so keying on it would
// fragment the cache for nothing. Defaulted, so every picker call site keeps its two-argument shape.
// Key, read and freshness in one builder, so every observer of a listing reads it the same way.
export function driveListingQueryOptions(variant: DriveVariant, uuid: string | null, path: readonly string[] = []) {
	return {
		...listingRefetchPolicy,
		queryKey: driveListingQueryKey({ variant, uuid }),
		queryFn: async (): Promise<DriveItem[]> => {
			if (variant === "sharedIn" || variant === "sharedOut") {
				return (await readApplyingPatches({ variant, uuid }, () => fetchSharedListing(variant, uuid, path))).items
			}

			return readListing(variant, uuid)
		}
	}
}

export function useDirectoryListingQuery(
	variant: DriveVariant,
	uuid: string | null,
	path: readonly string[] = []
): UseQueryResult<DriveItem[]> {
	return useQuery(driveListingQueryOptions(variant, uuid, path))
}

// Sidebar directory-tree primitive: the minimal per-node shape the collapsible Cloud Drive tree
// renders — just a uuid, a display name (its raw meta name, uuid-fallback like every listing row) and
// its color. The move-dialog can adopt the same primitive later by feeding it this same hook.
export interface DirectoryTreeChild {
	uuid: string
	name: string
	color: DirColor
}

// Directories only, name-sorted independent of any listing sort preference. Module-level so `select`
// keeps a stable reference and only re-runs when the listing data itself changes.
export function projectTreeChildren(items: DriveItem[]): DirectoryTreeChild[] {
	const children: DirectoryTreeChild[] = []

	for (const item of items) {
		if (item.type === "directory") {
			children.push({ uuid: item.data.uuid, name: driveItemName(item), color: item.data.color })
		}
	}

	return children.sort((a, b) => fastLocaleCompare(a.name, b.name))
}

// Reads the drive listing's own cache entry rather than a slice of its own: listDirectory returns a
// directory's files alongside its dirs in one call anyway, so sharing the key costs nothing and lets
// the tree and the main pane dedupe one in-flight fetch, one focus/reconnect refetch, and pick up the
// listing's socket patches. Same options as useDirectoryListingQuery — two observers on one key must
// never disagree on how it is fetched. Lazy per node: a node's query only mounts once its subtree does
// (see directoryTree.tsx), so an unopened node never fetches.
export function useDirectoryTreeChildrenQuery(uuid: string | null): UseQueryResult<DirectoryTreeChild[]> {
	return useQuery({
		...driveListingQueryOptions("drive", uuid),
		select: projectTreeChildren
	})
}

// A listing as the cache holds it: never a fetch.
export function cachedListing(variant: DriveVariant, uuid: string | null): DriveItem[] | undefined {
	return queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant, uuid }))
}

// The row behind a sidebar tree node, as the "drive" listing its level rendered from holds it: a cache
// read, never a fetch — that level is mounted, so its listing is cached. `parentUuid` is null for a
// root-level node.
export function cachedTreeDirectory(parentUuid: string | null, uuid: string): Extract<DriveItem, { type: "directory" }> | undefined {
	const found = cachedListing("drive", parentUuid)?.find(item => item.data.uuid === uuid)

	return found?.type === "directory" ? found : undefined
}

// Shared listings, keyed in the same taxonomy as normal listings (variant carries sharedIn/sharedOut)
// but fetched through their own worker ops. A null uuid lists the shared root (each returned item
// already carries its own share role, so narrowItem classifies it structurally); a non-null uuid
// browses into a nested shared directory, where the worker returns the parent role and this CONTEXT-
// TAGS every nested dir/file with it BEFORE narrowing — a nested SharedDir/File is otherwise
// structurally a plain dir/file and can't be classified as shared. Exported (no hook wrapper of its
// own — useDirectoryListingQuery's variant dispatch calls it directly) so this project's
// node-environment unit tests can exercise it against a mocked sdkApi.
// `path` is the route splat's full ancestor-uuid chain (the target itself last) — a resolution HINT
// for a cold worker whose in-session share-context map has never seen this uuid (a reload, bookmark,
// restored tab or pasted URL), never part of the listing's identity. The root listing needs none.
export async function fetchSharedListing(
	variant: "sharedIn" | "sharedOut",
	uuid: string | null,
	path: readonly string[] = []
): Promise<DriveItem[]> {
	if (uuid === null) {
		const { dirs, files } = variant === "sharedIn" ? await sdkApi.listSharedInRoot() : await sdkApi.listSharedOutRoot()
		return [...dirs.map(narrowItem), ...files.map(narrowItem)]
	}

	const { dirs, files, role } = await sdkApi.listSharedDirectory(uuid, { variant, path: [...path] })
	return [...dirs.map(dir => narrowItem({ ...dir, sharingRole: role })), ...files.map(file => narrowItem({ ...file, sharingRole: role }))]
}

function listingQuery(params: DriveListingParams): Query | undefined {
	return cachedQuery(driveListingQueryKey(params))
}

// Read this session under the live socket and not marked stale since, so every change has reached its rows.
function isCurrentListing(query: Query, params: DriveListingParams): boolean {
	return !query.state.isInvalidated && listingsReadThisSession.has(listingId(params.variant, params.uuid))
}

// For the sidebar tree: whether a "drive" listing's rows are authoritative, unlike a disk-restored,
// socketless or stale-marked one, which may still hold directories that are gone.
export function isDriveListingCurrent(uuid: string | null): boolean {
	const params: DriveListingParams = { variant: "drive", uuid }
	const query = listingQuery(params)

	return query !== undefined && isCurrentListing(query, params)
}

// A read's changes applied to what it returned in as few passes as their order allows, so a burst of k
// changes to n rows costs O(n + k) instead of a pass each: removals and replacements gather into one
// pass, with the upserts or appends after them. A change that would act differently once gathered applies
// what is gathered first.
export function applyListingChanges(items: DriveItem[], changes: readonly ListingChange[], from = 0): DriveItem[] {
	let result = items
	const removed = new Set<string>()
	const replaced = new Map<string, (row: DriveItem) => DriveItem>()
	const upserted: DriveItem[] = []
	const upsertedUuids = new Set<string>()
	const appended = new Map<string, DriveItem>()

	const flush = (): void => {
		if (removed.size > 0 || replaced.size > 0 || appended.size > 0) {
			const kept: DriveItem[] = []

			for (const row of result) {
				const uuid = row.data.uuid

				if (removed.has(uuid) || appended.has(uuid)) {
					continue
				}

				const replace = replaced.get(uuid)

				kept.push(replace === undefined ? row : replace(row))
			}

			for (const row of appended.values()) {
				kept.push(row)
			}

			result = kept
		}

		if (upserted.length > 0) {
			result = upsertItems(result, upserted)
		}

		removed.clear()
		replaced.clear()
		upserted.length = 0
		upsertedUuids.clear()
		appended.clear()
	}

	for (let index = from; index < changes.length; index++) {
		const change = changes[index]

		if (change === undefined) {
			continue
		}

		switch (change.type) {
			case "remove": {
				// An upsert also made way for its name, which dropping its row alone would undo.
				if (upsertedUuids.has(change.uuid)) {
					flush()
				}

				appended.delete(change.uuid)
				removed.add(change.uuid)

				break
			}

			case "replace": {
				// A replacement may rename a row, which decides whether an upsert before it made way for it.
				if (upserted.length > 0) {
					flush()
				}

				const row = appended.get(change.uuid)

				if (row !== undefined) {
					appended.set(change.uuid, change.replace(row))

					break
				}

				const earlier = replaced.get(change.uuid)

				replaced.set(change.uuid, earlier === undefined ? change.replace : current => change.replace(earlier(current)))

				break
			}

			case "upsert": {
				if (appended.size > 0) {
					flush()
				}

				for (const item of change.items) {
					upserted.push(item)
					upsertedUuids.add(item.data.uuid)
				}

				break
			}

			case "append": {
				if (upserted.length > 0) {
					flush()
				}

				// Appending a row again moves it to the end.
				for (const item of change.items) {
					appended.delete(item.data.uuid)
					appended.set(item.data.uuid, item)
				}

				break
			}

			case "update": {
				flush()

				result = change.update(result)

				break
			}
		}
	}

	flush()

	return result
}

// A row change leaves a listing that doesn't hold the row as it was, so the caller can skip writing it.
function applyListingChange(items: DriveItem[], change: ListingChange): DriveItem[] {
	switch (change.type) {
		case "remove": {
			return items.some(row => row.data.uuid === change.uuid) ? removeByUuid(items, change.uuid) : items
		}

		case "replace": {
			let next: DriveItem[] | undefined

			for (let index = 0; index < items.length; index++) {
				const row = items[index]

				if (row?.data.uuid !== change.uuid) {
					continue
				}

				const replaced = change.replace(row)

				if (replaced !== row) {
					next ??= [...items]
					next[index] = replaced
				}
			}

			return next ?? items
		}

		case "append": {
			// The very rows a listing already holds, as a socket echo of this client's own patch carries them.
			if (change.items.every(item => items.includes(item))) {
				return items
			}

			return applyListingChanges(items, [change])
		}

		case "upsert":
		case "update": {
			return applyListingChanges(items, [change])
		}
	}
}

function asListingChange(change: ListingChange | ListingPatch): ListingChange {
	return typeof change === "function" ? { type: "update", update: change } : change
}

// A patch to one listing, or to every listing `where` picks (all of them without one).
type Patch =
	| { params: DriveListingParams; change: ListingChange }
	| { params: undefined; where: ((params: DriveListingParams) => boolean) | undefined; change: ListingRowChange }

function patchChangeFor(patch: Patch, params: DriveListingParams): ListingChange | undefined {
	if (patch.params === undefined) {
		return patch.where === undefined || patch.where(params) ? patch.change : undefined
	}

	return patch.params.variant === params.variant && patch.params.uuid === params.uuid ? patch.change : undefined
}

// Row changes to rows a listing doesn't hold leave it as it was, however many land. So does an append of the
// very rows it holds (a socket echo of this client's own patch) that nothing before it touched.
function applyHeldChanges(items: DriveItem[], changes: readonly ListingChange[]): DriveItem[] {
	const [first] = changes

	if (changes.length === 1 && first !== undefined) {
		return applyListingChange(items, first)
	}

	// The rows the changes kept so far name; an upsert or an edit may touch any row.
	const uuids = new Set<string>()
	let touchesAny = false
	let rowsOnly = true
	let held: Set<DriveItem> | undefined
	let kept: ListingChange[] | undefined

	for (let index = 0; index < changes.length; index++) {
		const change = changes[index]

		if (change === undefined) {
			continue
		}

		if (change.type === "append" && !touchesAny) {
			const rows = (held ??= new Set(items))

			if (change.items.every(item => rows.has(item) && !uuids.has(item.data.uuid))) {
				kept ??= changes.slice(0, index)

				continue
			}
		}

		kept?.push(change)

		switch (change.type) {
			case "remove":
			case "replace": {
				uuids.add(change.uuid)

				break
			}

			case "append": {
				rowsOnly = false

				for (const item of change.items) {
					uuids.add(item.data.uuid)
				}

				break
			}

			case "upsert":
			case "update": {
				rowsOnly = false
				touchesAny = true

				break
			}
		}
	}

	const rest = kept ?? changes

	if (!rowsOnly) {
		return applyListingChanges(items, rest)
	}

	return items.some(row => uuids.has(row.data.uuid)) ? applyListingChanges(items, rest) : items
}

function nestedShareRole(rows: readonly DriveItem[]): SharingRole | undefined {
	for (const row of rows) {
		if ((row.type === "sharedFile" || row.type === "sharedDirectory") && row.data.sharingRole !== undefined) {
			return row.data.sharingRole
		}
	}

	return undefined
}

// A directory this account shared out also lists under Shared by me, each row tagged with the share's role,
// so a change to its drive listing reaches that listing too. A removal applies as it is and a new file joins
// with the role the listing's rows hold. Nothing else can be tagged here (a directory's row carries the
// SDK's own SharedDir, an edit may touch any row), so that listing reads again instead.
function sharedOutMirror(patch: Patch): ListingChange | "reread" | undefined {
	const target = patch.params

	if (target?.variant !== "drive" || target.uuid === null) {
		return undefined
	}

	const rows = listingQuery({ variant: "sharedOut", uuid: target.uuid })?.state.data as DriveItem[] | undefined

	if (rows === undefined && !listingReads.has(listingId("sharedOut", target.uuid))) {
		return undefined
	}

	const { change } = patch

	if (change.type === "remove") {
		return change
	}

	const role = rows === undefined ? undefined : nestedShareRole(rows)

	if (change.type !== "upsert" || role === undefined) {
		return "reread"
	}

	const files: DriveItem[] = []

	for (const item of change.items) {
		if (item.type !== "file") {
			return "reread"
		}

		files.push(narrowItem({ ...item.data, sharingRole: role }))
	}

	return { type: "upsert", items: files }
}

// One lookup per listing by the key's hash: a filter find() copies and re-hashes the whole query cache.
function patchedQueries(patches: readonly Patch[]): Query[] {
	const queries = new Map<string, Query | undefined>()

	for (const patch of patches) {
		if (patch.params === undefined) {
			return cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)
		}

		const id = listingId(patch.params.variant, patch.params.uuid)

		if (!queries.has(id)) {
			queries.set(id, listingQuery(patch.params))
		}
	}

	return [...queries.values()].filter(query => query !== undefined)
}

// A read under way gets each change through its replay, cached data directly, in one write per listing. A
// listing nobody has read gets neither: made from the rows a change adds, it would show as that directory's
// whole content until its read, and a copy or a directory upload would leave one such entry behind per
// directory it creates.
function applyPatches(queued: readonly Patch[]): void {
	const patches: Patch[] = []
	const rereads = new Map<string, DriveListingParams>()

	for (const patch of queued) {
		patches.push(patch)

		const mirror = sharedOutMirror(patch)

		if (mirror === undefined || patch.params === undefined) {
			continue
		}

		const params: DriveListingParams = { variant: "sharedOut", uuid: patch.params.uuid }

		if (mirror === "reread") {
			rereads.set(listingId(params.variant, params.uuid), params)
		} else {
			patches.push({ params, change: mirror })
		}
	}

	for (const reads of listingReads.values()) {
		for (const patch of patches) {
			const change = patchChangeFor(patch, reads.params)

			if (change !== undefined) {
				reads.changes.push(change)
			}
		}
	}

	for (const query of patchedQueries(patches)) {
		const prev = query.state.data as DriveItem[] | undefined

		if (prev === undefined) {
			continue
		}

		const params = (query.queryKey as ReturnType<typeof driveListingQueryKey>)[2]
		const changes: ListingChange[] = []

		for (const patch of patches) {
			const change = patchChangeFor(patch, params)

			if (change !== undefined) {
				changes.push(change)
			}
		}

		if (changes.length === 0) {
			continue
		}

		const next = applyHeldChanges(prev, changes)

		// Most cached listings don't hold the row; writing one would re-render it for nothing.
		if (next !== prev) {
			setQueryDataKeepInvalidated(query, next)
		}
	}

	for (const params of rereads.values()) {
		void queryClient.invalidateQueries({ queryKey: driveListingQueryKey(params), exact: true })
	}
}

// A bulk action's items finish one worker reply at a time, and a patch per reply would rewrite and re-render
// every listing holding one of them each time. While one runs, every patch queues with the creates, in
// order, and lands in one write per listing per window (batchListingPatches).
let queuedPatches: Patch[] = []
// The rows the queued patches name, and how many edit whole listings instead. An upsert also makes way for a
// same-name row, which only ever drops a duplicate.
const queuedRowUuids = new Set<string>()
// The rows the queued patches append to the trash and no later one removes from it: a trash echo of one of
// them has nothing left to insert.
const queuedTrashAppends = new Set<string>()
let queuedListingEdits = 0
let listingBatches = 0

const TRASH_LISTING: DriveListingParams = { variant: "trash", uuid: null }

function patchReachesTrash(patch: Patch): boolean {
	return patch.params === undefined ? patch.where === undefined || patch.where(TRASH_LISTING) : patch.params.variant === "trash"
}

function queuePatch(patch: Patch): void {
	queuedPatches.push(patch)

	const { change } = patch

	switch (change.type) {
		case "remove":
		case "replace": {
			queuedRowUuids.add(change.uuid)

			if (change.type === "remove" && queuedTrashAppends.size > 0 && patchReachesTrash(patch)) {
				queuedTrashAppends.delete(change.uuid)
			}

			break
		}

		case "upsert":
		case "append": {
			const toTrash = change.type === "append" && patchReachesTrash(patch)

			for (const item of change.items) {
				queuedRowUuids.add(item.data.uuid)

				if (toTrash) {
					queuedTrashAppends.add(item.data.uuid)
				}
			}

			break
		}

		case "update": {
			queuedListingEdits++

			break
		}
	}
}

function submitPatch(patch: Patch): void {
	if (listingBatches > 0) {
		// The creates queued before it land before it.
		for (const create of takeQueuedCreates()) {
			queuePatch(create)
		}

		queuePatch(patch)

		createFlushTimer ??= setTimeout(flushListingCreates, LISTING_CREATE_FLUSH_MS)

		return
	}

	flushListingCreates()
	applyPatches([patch])
}

// A socket event's entry flush, which a batch skips: submitPatch already lands the creates queued before a
// patch ahead of it, and a bulk action's own echoes would otherwise flush the batch once per item.
export function flushListingCreatesOutsideBatch(): void {
	if (listingBatches === 0) {
		flushListingCreates()
	}
}

// Whether a queued patch already appends this row to the trash: this client's own trash, not yet landed.
export function queuedTrashHolds(uuid: string): boolean {
	return queuedTrashAppends.has(uuid)
}

// Runs a bulk action with its listing patches queued; they land at the latest when it ends.
export async function batchListingPatches<T>(run: () => Promise<T>): Promise<T> {
	listingBatches++

	try {
		return await run()
	} finally {
		listingBatches--

		flushListingCreates()
	}
}

// Confirm-then-patch for a write landing in My Drive (queries/client.ts's zero-useMutation
// convention) — always the "drive" variant: the three flat listings (recents/favorites/trash) have
// no navigable parent to create/move into. A ListingChange folds into a read's replay with the others; a
// function costs that replay a pass of its own.
export function driveListingQueryUpdate(parentUuid: string | null, change: ListingChange | ListingPatch): void {
	submitPatch({ params: { variant: "drive", uuid: parentUuid }, change: asListingChange(change) })
}

// The flat listings (recents/favorites/trash/links) patched by their one key.
export function flatListingQueryUpdate(variant: FlatListingKind, change: ListingChange | ListingPatch): void {
	submitPatch({ params: { variant, uuid: null }, change: asListingChange(change) })
}

// A variant's root listing patched by its one key.
export function rootListingQueryUpdate(variant: DriveVariant, change: ListingChange | ListingPatch): void {
	submitPatch({ params: { variant, uuid: null }, change: asListingChange(change) })
}

// How long a created item waits to land in its parent listing together with the others created meanwhile.
export const LISTING_CREATE_FLUSH_MS = 250

// A copy or a many-file upload creates items by the thousand, each reported by the job and again by its
// socket echo, and every splice rewrites, re-sorts and re-renders the whole parent listing. Queued per
// parent and by uuid, they land in one write per listing per window. Every other listing patch applies
// the queue first, so nothing it removes, moves or edits comes back after it.
let queuedCreates = new Map<string | null, Map<string, DriveItem>>()
let queuedRecents = new Map<string, DriveItem>()
let createFlushTimer: ReturnType<typeof setTimeout> | undefined

// `recent`: a new file that also joins Recents.
export function queueListingCreate(parentUuid: string | null, item: DriveItem, options?: { recent: boolean }): void {
	let byUuid = queuedCreates.get(parentUuid)

	if (byUuid === undefined) {
		byUuid = new Map()

		queuedCreates.set(parentUuid, byUuid)
	}

	byUuid.set(item.data.uuid, item)

	if (options?.recent === true) {
		queuedRecents.set(item.data.uuid, item)
	}

	createFlushTimer ??= setTimeout(flushListingCreates, LISTING_CREATE_FLUSH_MS)
}

function takeQueuedCreates(): Patch[] {
	if (queuedCreates.size === 0) {
		return []
	}

	const patches: Patch[] = []

	for (const [parentUuid, byUuid] of queuedCreates) {
		patches.push({ params: { variant: "drive", uuid: parentUuid }, change: { type: "upsert", items: [...byUuid.values()] } })
	}

	if (queuedRecents.size > 0) {
		// Recents spans directories, so only the uuid dedups: two recent files may share a name.
		patches.push({ params: { variant: "recents", uuid: null }, change: { type: "append", items: [...queuedRecents.values()] } })
	}

	queuedCreates = new Map()
	queuedRecents = new Map()

	return patches
}

// Lands every queued create and patch.
export function flushListingCreates(): void {
	if (createFlushTimer !== undefined) {
		clearTimeout(createFlushTimer)

		createFlushTimer = undefined
	}

	if (queuedPatches.length === 0 && queuedCreates.size === 0) {
		return
	}

	// A create still queued came after every queued patch.
	const patches = [...queuedPatches, ...takeQueuedCreates()]

	queuedPatches = []
	queuedRowUuids.clear()
	queuedTrashAppends.clear()
	queuedListingEdits = 0

	applyPatches(patches)
}

// Logout: the queued creates and patches, the changes kept for reads under way and which listings were read
// belong to the ended session.
export function discardListingPatches(): void {
	if (createFlushTimer !== undefined) {
		clearTimeout(createFlushTimer)

		createFlushTimer = undefined
	}

	queuedCreates = new Map()
	queuedRecents = new Map()
	queuedPatches = []
	queuedRowUuids.clear()
	queuedTrashAppends.clear()
	queuedListingEdits = 0
	listingReads.clear()
	listingsReadThisSession.clear()
}

// For a patch that can't carry its whole change (a directory row whose colour no current listing holds):
// the listing reads again on its next mount or focus, and a read under way, which gets the patch through
// its replay, doesn't count as current.
function markListingStale(params: DriveListingParams): void {
	const reads = listingReads.get(listingId(params.variant, params.uuid))

	if (reads !== undefined) {
		reads.marks++
	}

	listingQuery(params)?.invalidate()
}

export function markDriveListingStale(uuid: string | null): void {
	markListingStale({ variant: "drive", uuid })
}

// A flat listing reads on every mount and focus anyway, so this only stops it counting as current.
export function markFlatListingStale(variant: FlatListingKind): void {
	markListingStale({ variant, uuid: null })
}

// One flat listing re-read if mounted, else marked stale.
export function invalidateFlatListing(variant: FlatListingKind): void {
	void queryClient.invalidateQueries({ queryKey: driveListingQueryKey({ variant, uuid: null }), exact: true })
}

// Re-reads the mounted listings and marks the rest stale, for a change no event patches in place.
export function invalidateDriveListings(): void {
	listingStaleMarks++
	void queryClient.invalidateQueries({ queryKey: DRIVE_LISTING_KEY_PREFIX })
}

// Marks every listing stale without reading, for a change no event patches in place: each re-reads on
// its next mount or focus.
export function markListingsStale(): void {
	listingStaleMarks++
	void queryClient.invalidateQueries({ queryKey: DRIVE_LISTING_KEY_PREFIX, refetchType: "none" })
}

// Fan-out patch across EVERY currently-instantiated listing, any variant, any uuid — a
// `["drive","listing"]` queryKey filter only compares the indices IT specifies (verified against
// the installed @tanstack/query-core's partialMatchKey: it walks Object.keys of the FILTER key, so
// index 2's params object is never inspected), so this matches every "drive"/"recents"/"favorites"/
// "trash" listing at once, the null-root included. For an action whose effect isn't confined to one
// parent — an item can be favorited/colored in place, or moved out of one listing into another — a
// single narrow driveListingQueryUpdate call can't reach every affected key, but this can. A listing
// with no cached data is never written, so this can never conjure a `[]` into an unfetched query; one
// whose first read is under way gets the change through that read's replay. `where` limits it to the
// listings it picks.
export function driveListingQueryUpdateGlobal(change: ListingRowChange, where?: (params: DriveListingParams) => boolean): void {
	submitPatch({ params: undefined, where, change })
}

// The row behind a uuid as the first cached listing holding it holds it, shared or owned, however current:
// web keeps no worker-side item cache (mobile's fileUuidToNormalFile), so a listing row is the only full
// shape at hand. `undefined` when no cached listing holds the uuid.
export function findCachedListingItem(uuid: string): DriveItem | undefined {
	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		const found = (query.state.data as DriveItem[] | undefined)?.find(item => item.data.uuid === uuid)

		if (found !== undefined) {
			return found
		}
	}

	return undefined
}

// The owned row behind a uuid, as a current listing holds it where one does: read this session under the
// live socket and not marked stale since, so every change to the row has reached it. Otherwise as any
// cached listing holds it, which may be outdated: a listing restored from disk, read while the socket was
// down or left stale by a drop may have missed a change. Owned only: a shared row is never current, and
// only an owned row can join this account's trash. Queued creates land first, so a new row is found, and so
// do queued patches that may touch the row.
export function findOwnedListingItem(uuid: string): { item: DriveItem; current: boolean } | undefined {
	if (queuedCreates.size > 0 || queuedListingEdits > 0 || queuedRowUuids.has(uuid)) {
		flushListingCreates()
	}

	let outdated: DriveItem | undefined

	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		const current = isCurrentListing(query, (query.queryKey as ReturnType<typeof driveListingQueryKey>)[2])

		// Past the first match, only a current listing's row is worth a scan.
		if (!current && outdated !== undefined) {
			continue
		}

		const found = (query.state.data as DriveItem[] | undefined)?.find(
			item => item.data.uuid === uuid && (item.type === "directory" || item.type === "file")
		)

		if (found === undefined) {
			continue
		}

		if (current) {
			return { item: found, current: true }
		}

		outdated = found
	}

	return outdated === undefined ? undefined : { item: outdated, current: false }
}

// Dir/File.parent is NEVER null on the wasm side (ParentUuid = a real uuid or one of
// "trash"/"recents"/"favorites"/"links"), but a listing keys the drive ROOT as `uuid: null` (see
// driveListingQueryKey/toListingTarget) — there is no navigable "root uuid" segment in a query key,
// only the sentinel. A narrow patch keyed off a raw parent uuid (rename's breadcrumb aside, every
// other per-parent patch) must collapse the root's real uuid back to the sentinel before it can hit
// the right key; every other uuid — a real subdirectory, or a flat-listing marker no "drive"-variant
// patch ever receives — passes through unchanged.
export function normalizeParentUuid(parentUuid: string | null, rootUuid: string): string | null {
	return parentUuid === rootUuid ? null : parentUuid
}

// Breadcrumb primitive: a splat route carries the full ancestor-uuid path in the URL itself (see
// features/drive/lib/navigate.ts's splatToUuids), so only each crumb's DISPLAY NAME is resolved — no
// getItemPath walk. The resolution path follows the route: every non-shared variant browses owned
// directories, the two shared variants their own share tree.
export type DirectoryNameScope = "drive" | "sharedIn" | "sharedOut"

export function directoryNameScope(variant: DriveVariant): DirectoryNameScope {
	return variant === "sharedIn" || variant === "sharedOut" ? variant : "drive"
}

// One entry per uuid rather than per path, so a deeper path reuses every ancestor it shares with the
// one before it instead of re-resolving them under a new key.
export function driveNamesQueryKey(scope: DirectoryNameScope, uuid: string) {
	return ["drive", "names", scope, uuid] as const
}

// A directory's decrypted name as a cached listing already holds it — the parent listing a
// click-through came from always does, for owned and shared directories alike. Rename and socket events
// patch every listing (the sidebar tree reads the same entries).
export function cachedDirectoryName(uuid: string): string | undefined {
	const item = findCachedListingItem(uuid)

	if (item === undefined || !isDirectoryItem(item)) {
		return undefined
	}

	return item.data.decryptedMeta?.name
}

// Every directory name the cached listings and breadcrumb entries hold, in one pass: for a caller naming
// many directories at once, where cachedDirectoryName would scan the listings per uuid. No requests.
export function cachedDirectoryNames(): Map<string, string> {
	const names = new Map<string, string>()

	for (const [queryKey, name] of queryClient.getQueriesData<string | null>({ queryKey: ["drive", "names"] })) {
		const uuid = queryKey[3]

		if (typeof uuid === "string" && typeof name === "string") {
			names.set(uuid, name)
		}
	}

	// Listing rows win: socket renames patch listings, not the breadcrumb entries.
	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		for (const item of (query.state.data as DriveItem[] | undefined) ?? []) {
			const name = isDirectoryItem(item) ? item.data.decryptedMeta?.name : undefined

			if (name !== undefined) {
				names.set(item.data.uuid, name)
			}
		}
	}

	return names
}

// `path` is the crumb's ancestor chain, the crumb itself last. Cached listings first, so a
// click-through never reaches the worker; otherwise one worker call, which is itself cache-first and
// only then asks the SDK: owned lookup for an owned directory, the share walk (hinted with `path`) for
// a shared one. null means unresolvable and renders as the raw uuid.
export async function fetchDirectoryName(scope: DirectoryNameScope, path: readonly string[]): Promise<string | null> {
	const uuid = path.at(-1)

	if (uuid === undefined) {
		return null
	}

	const cached = cachedDirectoryName(uuid)

	if (cached !== undefined) {
		return cached
	}

	return scope === "drive" ? sdkApi.resolveDirectoryName(uuid) : sdkApi.resolveDirectoryName(uuid, { variant: scope, path: [...path] })
}

// A paste destination's name, for its copy card. A directory opened by a deep link or a reveal often has
// no cached parent listing, so its name may only be in the breadcrumb's entry, which this reads, or joins
// while it still resolves, instead of asking again. A cached listing row still wins: socket renames patch
// listings, not the breadcrumb.
export async function destinationDirectoryName(scope: DirectoryNameScope, path: readonly string[]): Promise<string | null> {
	const uuid = path.at(-1)

	if (uuid === undefined) {
		return null
	}

	return (
		cachedDirectoryName(uuid) ??
		queryClient.query({
			queryKey: driveNamesQueryKey(scope, uuid),
			queryFn: () => fetchDirectoryName(scope, path),
			staleTime: Infinity
		})
	)
}

export type DirectoryNamesResult =
	| { status: "pending"; data: undefined; error: null }
	| { status: "error"; data: undefined; error: Error }
	| { status: "success"; data: Record<string, string>; error: null }

interface DirectoryNameQueryState {
	status: "pending" | "error" | "success"
	data: string | null | undefined
	error: Error | null
}

// Folds the per-uuid entries back into the one record every breadcrumb renders: any error wins, then
// any pending, else every resolved name (an unresolved uuid is simply absent — the caller falls back to
// the raw uuid for that one crumb).
export function combineDirectoryNames(uuids: readonly string[], results: readonly DirectoryNameQueryState[]): DirectoryNamesResult {
	const names: Record<string, string> = {}
	let pending = false

	for (const [index, result] of results.entries()) {
		if (result.status === "error" && result.error !== null) {
			return { status: "error", data: undefined, error: result.error }
		}

		if (result.status === "pending") {
			pending = true
			continue
		}

		const uuid = uuids[index]

		if (uuid !== undefined && typeof result.data === "string") {
			names[uuid] = result.data
		}
	}

	return pending ? { status: "pending", data: undefined, error: null } : { status: "success", data: names, error: null }
}

// Default staleTime on purpose: a remount refetch re-reads the listings rename and socket events keep
// current, and it costs no request while they hold the name.
export function useDirectoryNamesQuery(uuids: string[], variant: DriveVariant = "drive"): DirectoryNamesResult {
	const scope = directoryNameScope(variant)

	return useQueries({
		queries: uuids.map((uuid, index) => ({
			queryKey: driveNamesQueryKey(scope, uuid),
			queryFn: () => fetchDirectoryName(scope, uuids.slice(0, index + 1))
		})),
		combine: results => combineDirectoryNames(uuids, results)
	})
}

// Info panel primitive: an on-demand, single-item path + ancestors read (see sdk.worker.ts's
// ItemInfoResult) — keyed on the item's own uuid so switching between two items' info panels never
// shows a stale read while the new one is still in flight. A directory's size is not part of it: the
// panel reads directorySizeQueryKey, the entry the listing's row prefetch already fills.
export function itemInfoQueryKey(uuid: string) {
	return ["drive", "itemInfo", uuid] as const
}

export async function fetchItemInfo(item: Dir | File): Promise<ItemInfoResult> {
	return sdkApi.getItemInfo(item)
}

// `enabled` lets a caller skip the fetch entirely rather than rely on a `.catch` to rescue it — the
// info dialog does this for a trashed item, since getItemPath stalls rather than rejects on a
// trashed item's unresolvable ancestry (see sdk.worker.ts's getItemInfo), and a stalled promise
// can't be caught. Defaults to true so every other caller is unaffected.
export function useItemInfoQuery(item: Dir | File, options?: { enabled?: boolean }): UseQueryResult<ItemInfoResult> {
	return useQuery({
		queryKey: itemInfoQueryKey(item.uuid),
		queryFn: () => fetchItemInfo(item),
		enabled: options?.enabled ?? true
	})
}

// The reveal's ancestor-chain read (features/drive/lib/reveal.ts). Its OWN key, not itemInfoQueryKey:
// that entry holds getItemInfo's swallow-on-failure shape, exactly what the rejecting worker op exists
// to avoid. The duplicated cost versus a warm info entry is one path walk.
export function itemPathQueryKey(uuid: string) {
	return ["drive", "itemPath", uuid] as const
}

export async function fetchItemPath(item: Dir | File): Promise<GetItemPathResult> {
	return sdkApi.getItemPath(item)
}

// Per-directory recursive size aggregate (bytes + child file/dir counts), keyed on the directory's
// own uuid. One cache slice serves three consumers: the row size column (useDriveDirectorySizes
// prefetches a listing's directories under this exact key — see directoryListing.tsx), at sort time
// the size sort, and the info dialog's size rows — so opening Info on a directory whose row already
// resolved a size costs no second getDirSize.
export type DirectorySizeItem = DirectoryLikeItem

// 15-minute staleTime: a directory's recursive size is expensive to recompute server-side and drifts
// slowly, so unlike the client's refetch-everything default (staleTime 0) this holds its value across
// mounts/focus. (TODO: revisit with API v4.)
export const DIRECTORY_SIZE_STALE_TIME = 15 * 60 * 1000

export function directorySizeQueryKey(uuid: string) {
	return ["drive", "dirSize", uuid] as const
}

// Builds the AnyDirWithContext on the main thread (item.ts's toAnyDirWithContext handles owned-vs-
// shared dispatch) and hands it to the thin worker op. Exported bare so node-environment unit tests
// exercise the routing against a mocked sdkApi, same as every other fetch in this module.
export async function fetchDirectorySize(item: DirectorySizeItem): Promise<DirSizeResponse> {
	return sdkApi.getDirSize(toAnyDirWithContext(item))
}

// Key + fn + freshness in ONE builder so useDirectorySizeQuery (the info dialog) and the size-sort bridge's
// prefetch can never drift onto different keys — a prefetch under a mismatched key would fetch a
// second time and the reader would find nothing.
export function directorySizeQueryOptions(item: DirectorySizeItem) {
	return {
		queryKey: directorySizeQueryKey(item.data.uuid),
		queryFn: () => fetchDirectorySize(item),
		staleTime: DIRECTORY_SIZE_STALE_TIME
	}
}

export function useDirectorySizeQuery(item: DirectorySizeItem): UseQueryResult<DirSizeResponse> {
	return useQuery(directorySizeQueryOptions(item))
}

// Versions panel primitive: an on-demand read of a single file's version history, newest first (the
// SDK sorts server-side — see filen-sdk-rs's list_file_versions). Keyed on the file's own (current)
// uuid, same rationale as itemInfoQueryKey.
export function fileVersionsQueryKey(uuid: string) {
	return ["drive", "fileVersions", uuid] as const
}

export async function fetchFileVersions(file: File): Promise<FileVersion[]> {
	return sdkApi.listFileVersionsOp(file)
}

export function useFileVersionsQuery(file: File): UseQueryResult<FileVersion[]> {
	return useQuery({
		queryKey: fileVersionsQueryKey(file.uuid),
		queryFn: () => fetchFileVersions(file)
	})
}

// Sort/view-mode preferences live in kv storage (features/drive/lib/preferences.ts), not the SDK — reading
// them as queries anyway keeps every async read in this app on the same primitive (caching,
// persistence, refetch-on-focus) instead of a one-off useEffect. Writes stay plain-fn-then-refetch,
// same convention as every other write in this app (see queries/client.ts's zero-useMutation note):
// the caller awaits the kv setter, then calls this query's own `.refetch()`.
export function useSortPreferencesQuery(): UseQueryResult<DrivePreferences<DriveSortBy>> {
	return useQuery({
		queryKey: ["drive", "sortPreferences"] as const,
		queryFn: getSortPreferences
	})
}

export function useViewModePreferencesQuery(): UseQueryResult<DrivePreferences<DriveViewMode>> {
	return useQuery({
		queryKey: ["drive", "viewModePreferences"] as const,
		queryFn: getViewModePreferences
	})
}

// Same kv-backed-preference-as-a-query convention as the two above — the HEIC/HEIF-to-JPG
// convert-on-upload toggle (features/drive/lib/heicUpload.ts), surfaced in Advanced settings.
export function useHeicUploadConvertPreferenceQuery(): UseQueryResult<boolean> {
	return useQuery({
		queryKey: ["drive", "heicUploadConvertPreference"] as const,
		queryFn: getHeicUploadConvertPreference
	})
}

// Same convention again — the hide-dot-prefixed-items display filter, surfaced from the drive
// toolbar's Display menu.
export function useHideHiddenItemsPreferenceQuery(): UseQueryResult<boolean> {
	return useQuery({
		queryKey: ["drive", "hideHiddenItemsPreference"] as const,
		queryFn: getHideHiddenItems
	})
}

// Public-link panel primitive: tags the worker's per-type status read with which type it is —
// DirPublicLinkRW and FilePublicLink share no discriminant field of their own (their download flag
// is even named differently, see linkDialog.logic.ts), so callers that need to know which shape
// they're holding (building an update, constructing the link URL) would otherwise have to re-derive
// it structurally. `null` means no link exists yet (the SDK's own idempotent-check-first shape);
// there is no separate "not fetched" state here — that's the query's own pending/error status.
export type DriveItemLinkStatus = { type: "directory"; status: DirPublicLinkRW } | { type: "file"; status: FilePublicLink }

export function driveItemLinkStatusQueryKey(uuid: string) {
	return ["drive", "linkStatus", uuid] as const
}

export async function fetchDriveItemLinkStatus(item: DriveItem): Promise<DriveItemLinkStatus | null> {
	const base = asDirectoryOrFile(item)

	if (base.type === "directory") {
		const status = await sdkApi.getDirectoryLinkStatus(base.data)
		return status ? { type: "directory", status } : null
	}

	const status = await sdkApi.getFileLinkStatus(base.data)
	return status ? { type: "file", status } : null
}

export function useDriveItemLinkStatusQuery(item: DriveItem): UseQueryResult<DriveItemLinkStatus | null> {
	return useQuery({
		queryKey: driveItemLinkStatusQueryKey(item.data.uuid),
		queryFn: () => fetchDriveItemLinkStatus(item)
	})
}

// Confirm-then-patch after create/update/disable (queries/client.ts's zero-useMutation convention) —
// a link never changes the item's listing presence, so this is the only cache this feature ever
// patches (contrast actions.ts's other writes, which also touch one or more listing keys).
export function driveItemLinkStatusQueryUpdate(uuid: string, next: DriveItemLinkStatus | null): void {
	queryClient.setQueryData<DriveItemLinkStatus | null>(driveItemLinkStatusQueryKey(uuid), next)
}
