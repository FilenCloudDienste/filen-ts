import { useQueries, useQuery, type Query, type QueryKey, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
// Whole-statement `import type` here too — sdk.worker.ts's own top-level code pulls in
// @filen/sdk-rs as a real value import, same elision hazard as above.
import type { ListDirectoryTarget, ItemInfoResult } from "@/workers/sdk.worker"
import type { Dir, File, FileVersion, DirPublicLinkRW, FilePublicLink, DirColor, DirSizeResponse, GetItemPathResult } from "@filen/sdk-rs"
import { fastLocaleCompare, driveItemName } from "@filen/shared"
import { narrowItem, asDirectoryOrFile, toAnyDirWithContext, type DriveItem } from "@/features/drive/lib/item"
import {
	getHideHiddenItems,
	getSortPreferences,
	getViewModePreferences,
	type DrivePreferences,
	type DriveVariant,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import { getHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"

// Query key taxonomy per client.ts ([domain, entity, params?]): `uuid` is null for every flat
// listing (recents/favorites/trash) and for My Drive's own root, so a fast nav between two
// directories only ever changes this one key's `uuid` — the rest of the shape is fixed per variant.
export interface DriveListingParams {
	variant: DriveVariant
	uuid: string | null
}

export function driveListingQueryKey(params: DriveListingParams) {
	return ["drive", "listing", params] as const
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

// My Drive listings whose latest read ran entirely under a live socket, by uuid (null = root). A
// persisted listing restores with its original read time, a patch can create one no read backs
// (driveListingQueryUpdate's `prev ?? []`), and a read the socket wasn't up for may predate an event
// it never delivered, so none of those count.
const driveListingsReadThisSession = new Set<string | null>()

async function readDriveListing(uuid: string | null): Promise<DriveItem[]> {
	const epoch = currentSocketEpoch()
	const items = await fetchDirectoryListing("drive", uuid)

	if (socketLiveSince(epoch)) {
		driveListingsReadThisSession.add(uuid)
	} else {
		driveListingsReadThisSession.delete(uuid)
	}

	return items
}

// A read My Drive listing changes only through writes and socket events that patch it in place, so it
// stays fresh until a socket drop or an unpatchable event invalidates it (socketHandlers.ts); the first
// mount after boot still reads. The other variants gain rows no event inserts (a move strips a
// favorite or recent, a link or share made elsewhere), so they keep the default. A network reconnect
// always re-reads: events may have been missed meanwhile. Both observers of a key take these together,
// since focus/reconnect refetch whenever any one observer asks.
const listingRefetchPolicy = {
	staleTime: (query: { queryKey: ReturnType<typeof driveListingQueryKey> }) => {
		const { variant, uuid } = query.queryKey[2]

		return variant === "drive" && driveListingsReadThisSession.has(uuid) ? Infinity : 0
	},
	refetchOnReconnect: "always"
} as const

// dirs/files bigints (timestamp, size, chunks, meta created/modified/size) cross Comlink via
// structured clone already (see sdk.worker.ts); this module never JSON.stringifies them, and the
// result rides the persister's own envelope serializer at rest — zero customization needed here.
//
// One hook serves every variant — DirectoryListing is variant-generic, so rules-of-hooks forbid
// picking between two listing hooks per render. The queryFn dispatches instead: the two shared
// variants fetch through fetchSharedListing (whose worker ops return a different result shape than
// listDirectory — see fetchSharedListing / toListingTarget's throw), everything else through
// fetchDirectoryListing. The guard narrows `variant` to the shared union, matching its param.
// `path` is a shared-variant resolution hint only (see fetchSharedListing) — deliberately NOT part of
// the query KEY: the same uuid lists the same contents however it was reached, so keying on it would
// fragment the cache for nothing. Defaulted, so every picker call site keeps its two-argument shape.
export function useDirectoryListingQuery(
	variant: DriveVariant,
	uuid: string | null,
	path: readonly string[] = []
): UseQueryResult<DriveItem[]> {
	return useQuery({
		...listingRefetchPolicy,
		queryKey: driveListingQueryKey({ variant, uuid }),
		queryFn: () => {
			if (variant === "sharedIn" || variant === "sharedOut") {
				return fetchSharedListing(variant, uuid, path)
			}

			return variant === "drive" ? readDriveListing(uuid) : fetchDirectoryListing(variant, uuid)
		}
	})
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
// listing's socket patches. Same queryFn as useDirectoryListingQuery's "drive" arm — two observers on
// one key must never disagree on how it is fetched. Lazy per node: a node's query only mounts once
// its subtree does (see directoryTree.tsx), so an unopened node never fetches.
export function useDirectoryTreeChildrenQuery(uuid: string | null): UseQueryResult<DirectoryTreeChild[]> {
	return useQuery({
		...listingRefetchPolicy,
		queryKey: driveListingQueryKey({ variant: "drive", uuid }),
		queryFn: () => readDriveListing(uuid),
		select: projectTreeChildren
	})
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

// Confirm-then-patch for a write landing in My Drive (queries/client.ts's zero-useMutation
// convention) — always the "drive" variant: the three flat listings (recents/favorites/trash) have
// no navigable parent to create/move into. A cache miss (nobody has viewed this directory yet)
// defaults to [] so the patch still lands for whenever it first mounts.
export function driveListingQueryUpdate(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]): void {
	const queryKey = driveListingQueryKey({ variant: "drive", uuid: parentUuid })
	const pending = isRefreshPending(queryClient.getQueryCache().find({ queryKey, exact: true }))

	cancelListingFetch(queryKey)
	queryClient.setQueryData<DriveItem[]>(queryKey, prev => updater(prev ?? []))

	if (pending) {
		keepRefreshPending(queryKey)
	}
}

// setQueryData marks a listing fresh, dropping a pending invalidation and the refetch a patch cancels.
// A read My Drive listing never goes stale on its own, so left unrestored, the change behind them
// would never be read.
function isRefreshPending(query: Query | undefined): boolean {
	return query !== undefined && (query.state.isInvalidated || query.state.fetchStatus !== "idle")
}

function keepRefreshPending(queryKey: QueryKey): void {
	void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" })
}

// Re-reads the mounted listings and marks the rest stale, for a change no event patches in place.
export function invalidateDriveListings(): void {
	void queryClient.invalidateQueries({ queryKey: ["drive", "listing"] })
}

// The cancel half of this module's cancel-before-patch discipline, shared by every listing patch —
// the variant-hardcoded updater above, the fan-out below, and the flat recents/favorites keys those
// two can't single out (socketHandlers.ts, actions.ts). A refetch snapshotted on the server BEFORE a
// write lands after the patch and silently overwrites it, so anything in flight is aborted first.
// Only when cached data already exists: cancelling a query's INITIAL fetch would strand it on its
// loading state with nothing to show until the next mount/focus trigger, and the overwrite hazard
// only applies to data a patch can lose.
export function cancelListingFetch(queryKey: ReturnType<typeof driveListingQueryKey>): void {
	if (queryClient.getQueryData(queryKey) !== undefined) {
		void queryClient.cancelQueries({ queryKey, exact: true })
	}
}

// Every updater this fan-out receives is a filter/map, which allocates a fresh array even when nothing
// matched — so an array-reference check can't tell an affected listing from an untouched one, but an
// element-identity walk can.
function sameItems(prev: DriveItem[], next: DriveItem[]): boolean {
	return prev.length === next.length && prev.every((item, index) => item === next[index])
}

// Fan-out patch across EVERY currently-instantiated listing, any variant, any uuid — a
// `["drive","listing"]` queryKey filter only compares the indices IT specifies (verified against
// the installed @tanstack/query-core's partialMatchKey: it walks Object.keys of the FILTER key, so
// index 2's params object is never inspected), so this matches every "drive"/"recents"/"favorites"/
// "trash" listing at once, the null-root included. For an action whose effect isn't confined to one
// parent — an item can be favorited/colored in place, or moved out of one listing into another — a
// single narrow driveListingQueryUpdate call can't reach every affected key, but this can. A listing
// nobody has fetched yet has no cached data and is skipped entirely, so this can never conjure a `[]`
// into an unfetched query.
export function driveListingQueryUpdateGlobal(updater: (items: DriveItem[]) => DriveItem[]): void {
	for (const query of queryClient.getQueryCache().findAll({ queryKey: ["drive", "listing"] })) {
		const prev = queryClient.getQueryData<DriveItem[]>(query.queryKey)

		if (prev === undefined) {
			continue
		}

		const next = updater(prev)

		// Most cached listings hold no row a given updater touches, and an untouched listing must be left
		// strictly alone: cancelling its in-flight refetch (below) would strand it on pre-fetch rows until
		// the next mount/focus, since a cancelled fetch reverts and never retries on its own.
		if (sameItems(prev, next)) {
			continue
		}

		// Same in-flight-refetch hazard as driveListingQueryUpdate above, with the same initial-fetch
		// carve-out — only a listing that already holds data (and is actually changing) gets its fetch
		// aborted, so an initial fetch is never left stranded on its loading state.
		const pending = isRefreshPending(query)

		void queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
		queryClient.setQueryData<DriveItem[]>(query.queryKey, next)

		if (pending) {
			keepRefreshPending(query.queryKey)
		}
	}
}

// The row behind a uuid-only socket payload. Web keeps no worker-side item cache (mobile's
// fileUuidToNormalFile), so the only full shape available for such an event is the row a cached
// listing still holds — read it BEFORE a removal fan-out strips it. `undefined` when no cached listing
// holds the uuid: there is nothing to rebuild the row from, and the affected listing refetches on its
// next mount.
export function findCachedListingItem(uuid: string): DriveItem | undefined {
	for (const query of queryClient.getQueryCache().findAll({ queryKey: ["drive", "listing"] })) {
		const found = queryClient.getQueryData<DriveItem[]>(query.queryKey)?.find(item => item.data.uuid === uuid)

		if (found !== undefined) {
			return found
		}
	}

	return undefined
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
// click-through came from always does, for owned and shared directories alike. Listings, not the
// sidebar tree: rename and socket events patch every listing, while the tree is never patched.
export function cachedDirectoryName(uuid: string): string | undefined {
	const item = findCachedListingItem(uuid)

	if (item === undefined || asDirectoryOrFile(item).type !== "directory") {
		return undefined
	}

	return item.data.decryptedMeta?.name
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
export type DirectorySizeItem = Extract<DriveItem, { type: "directory" | "sharedDirectory" | "sharedRootDirectory" }>

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

// A directory's own cached size (if any consumer has ever prefetched/read it) goes stale the moment
// something writes new content into it — upload.ts is the caller, right after a file lands. The only
// observer a dirSize key can have is an open info dialog (useDriveDirectorySizes prefetches, it never
// `useQuery`s per row — see that hook's own comment), so this mostly just flags the entry stale; the
// next listing or info dialog that shows this directory refetches instead of serving pre-write bytes
// for the rest of DIRECTORY_SIZE_STALE_TIME. Root (null parent) has no dirSize entry to invalidate.
export function invalidateDirectorySize(uuid: string | null): void {
	if (uuid === null) {
		return
	}

	void queryClient.invalidateQueries({ queryKey: directorySizeQueryKey(uuid) })
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
// convert-on-upload toggle (features/drive/lib/heicUpload.ts), surfaced from the upload menu.
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
