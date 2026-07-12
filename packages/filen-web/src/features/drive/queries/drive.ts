import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
// Whole-statement `import type` here too — sdk.worker.ts's own top-level code pulls in
// @filen/sdk-rs as a real value import, same elision hazard as above.
import type { ListDirectoryTarget, ItemInfoResult } from "@/workers/sdk.worker"
import type { Dir, File, FileVersion, DirPublicLinkRW, FilePublicLink, AnyDirWithContext, DirColor, DirSizeResponse } from "@filen/sdk-rs"
import { fastLocaleCompare } from "@filen/utils"
import { narrowItem, asDirectoryOrFile, toAnyDirWithContext, type DriveItem } from "@/features/drive/lib/item"
import {
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

// dirs/files bigints (timestamp, size, chunks, meta created/modified/size) cross Comlink via
// structured clone already (see sdk.worker.ts); this module never JSON.stringifies them, and the
// result rides the persister's own envelope serializer at rest — zero customization needed here.
//
// One hook serves every variant — DirectoryListing is variant-generic, so rules-of-hooks forbid
// picking between two listing hooks per render. The queryFn dispatches instead: the two shared
// variants fetch through fetchSharedListing (whose worker ops return a different result shape than
// listDirectory — see fetchSharedListing / toListingTarget's throw), everything else through
// fetchDirectoryListing. The guard narrows `variant` to the shared union, matching its param.
export function useDirectoryListingQuery(variant: DriveVariant, uuid: string | null): UseQueryResult<DriveItem[]> {
	return useQuery({
		queryKey: driveListingQueryKey({ variant, uuid }),
		queryFn: () =>
			variant === "sharedIn" || variant === "sharedOut" ? fetchSharedListing(variant, uuid) : fetchDirectoryListing(variant, uuid)
	})
}

// Sidebar directory-tree primitive: the minimal per-node shape the collapsible Cloud Drive tree
// renders — just a uuid and a display name (its raw meta name, uuid-fallback like every listing row).
// Deliberately narrower than DriveItem: the tree only ever shows directories and never needs their
// files, meta, sort keys or share context, so it keys its own cache slice rather than reusing (and
// force-fetching the files of) the full listing query. The move-dialog can adopt the same primitive
// later by feeding it this same hook.
export interface DirectoryTreeChild {
	uuid: string
	name: string
	color: DirColor
}

export function directoryTreeQueryKey(uuid: string | null) {
	return ["drive", "tree", uuid] as const
}

// Reuses the existing listDirectory worker op (no new SDK surface) and filters to directories
// client-side — the tree never lists a directory's files. `uuid === null` is the drive root, matching
// toListingTarget's own root sentinel. Exported bare (no hook wrapper) so this project's
// node-environment unit tests can exercise it against a mocked sdkApi, same as fetchDirectoryListing.
export async function fetchDirectoryTreeChildren(uuid: string | null): Promise<DirectoryTreeChild[]> {
	const { dirs } = await sdkApi.listDirectory(uuid === null ? { kind: "root" } : { kind: "uuid", uuid })
	return dirs
		.map(dir => {
			const item = narrowItem(dir)
			return {
				uuid: item.data.uuid,
				name: item.data.decryptedMeta?.name ?? item.data.uuid,
				color: item.type === "directory" ? item.data.color : "default"
			}
		})
		.sort((a, b) => fastLocaleCompare(a.name, b.name))
}

// One query per tree node, lazily fetched: a node's children are only requested once its own subtree
// mounts (the tree renders a node's DirectoryTree child only while it's open — see directoryTree.tsx),
// so an unopened node never fetches. Keyed per uuid in the shared TanStack cache, so re-expanding a
// previously-opened node serves instantly from cache and a directory listing already viewed elsewhere
// stays independent of this slice.
export function useDirectoryTreeChildrenQuery(uuid: string | null): UseQueryResult<DirectoryTreeChild[]> {
	return useQuery({
		queryKey: directoryTreeQueryKey(uuid),
		queryFn: () => fetchDirectoryTreeChildren(uuid)
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
export async function fetchSharedListing(variant: "sharedIn" | "sharedOut", uuid: string | null): Promise<DriveItem[]> {
	if (uuid === null) {
		const { dirs, files } = variant === "sharedIn" ? await sdkApi.listSharedInRoot() : await sdkApi.listSharedOutRoot()
		return [...dirs.map(narrowItem), ...files.map(narrowItem)]
	}

	const { dirs, files, role } = await sdkApi.listSharedDirectory(uuid)
	return [...dirs.map(dir => narrowItem({ ...dir, sharingRole: role })), ...files.map(file => narrowItem({ ...file, sharingRole: role }))]
}

// Confirm-then-patch for a write landing in My Drive (queries/client.ts's zero-useMutation
// convention) — always the "drive" variant: the three flat listings (recents/favorites/trash) have
// no navigable parent to create/move into. A cache miss (nobody has viewed this directory yet)
// defaults to [] so the patch still lands for whenever it first mounts.
export function driveListingQueryUpdate(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]): void {
	const queryKey = driveListingQueryKey({ variant: "drive", uuid: parentUuid })

	// A refetch snapshotted on the server BEFORE this write would land after the patch and silently
	// overwrite it — abort anything in flight first. Only when cached data already exists: cancelling
	// a query's INITIAL fetch would strand it on its loading state with nothing to show until the
	// next mount/focus trigger, and the overwrite hazard only applies to data a patch can lose.
	if (queryClient.getQueryData(queryKey) !== undefined) {
		void queryClient.cancelQueries({ queryKey })
	}

	queryClient.setQueryData<DriveItem[]>(queryKey, prev => updater(prev ?? []))
}

// Fan-out patch across EVERY currently-instantiated listing, any variant, any uuid — a
// `["drive","listing"]` queryKey filter only compares the indices IT specifies (verified against
// the installed @tanstack/query-core's partialMatchKey: it walks Object.keys of the FILTER key, so
// index 2's params object is never inspected), so this matches every "drive"/"recents"/"favorites"/
// "trash" listing at once, the null-root included. For an action whose effect isn't confined to one
// parent — an item can be favorited/colored in place, or trashed out of a normal listing while
// simultaneously belonging to the trash's own flat listing — a single narrow driveListingQueryUpdate
// call can't reach every affected key, but this can. A listing nobody has fetched yet has no cached
// data; the updater never runs for it (returning `undefined` from the per-query updater is
// setQueryData's own documented no-op), so this can never conjure a `[]` into an unfetched query.
export function driveListingQueryUpdateGlobal(updater: (items: DriveItem[]) => DriveItem[]): void {
	for (const query of queryClient.getQueryCache().findAll({ queryKey: ["drive", "listing"] })) {
		// Same in-flight-refetch hazard as driveListingQueryUpdate above, with the same initial-fetch
		// carve-out — only queries that already hold data get their in-flight fetch aborted.
		if (query.state.data !== undefined) {
			void queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
		}

		queryClient.setQueryData<DriveItem[]>(query.queryKey, prev => (prev === undefined ? undefined : updater(prev)))
	}
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

// Breadcrumb primitive: the "/drive/$" splat carries the full ancestor-uuid path in the URL itself
// (see features/drive/lib/navigate.ts's splatToUuids) — this only resolves DISPLAY NAMES for that path's
// uuids, cache-first, in one batched worker call. No getItemPath walk, no per-ancestor Dir/File
// narrowing (a name lookup has no item-type union to narrow). A uuid this call can't resolve
// (not-found, undecryptable meta) is simply absent from the returned record — never a query error —
// so the breadcrumb degrades one segment at a time (uuid-fallback) instead of failing wholesale.
export function driveNamesQueryKey(uuids: string[]) {
	return ["drive", "names", uuids] as const
}

export async function fetchDirectoryNames(uuids: string[]): Promise<Record<string, string>> {
	if (uuids.length === 0) {
		return {}
	}
	return sdkApi.resolveDirectoryNames(uuids)
}

export function useDirectoryNamesQuery(uuids: string[]): UseQueryResult<Record<string, string>> {
	return useQuery({
		queryKey: driveNamesQueryKey(uuids),
		enabled: uuids.length > 0,
		queryFn: () => fetchDirectoryNames(uuids)
	})
}

// Info panel primitive: an on-demand, single-item read (path + ancestors + a directory-only size
// aggregate — see sdk.worker.ts's ItemInfoResult) — keyed on the item's own uuid so switching between
// two items' info panels never shows a stale read while the new one is still in flight.
export function itemInfoQueryKey(uuid: string) {
	return ["drive", "itemInfo", uuid] as const
}

// `dirContext` forwards the AnyDirWithContext a caller built for a shared directory (item.ts's
// toAnyDirWithContext) straight through to getDirSize — omitted, sdkApi.getItemInfo dispatches
// getDirSize off the bare item instead, correct for an owned directory but not a shared one.
export async function fetchItemInfo(item: Dir | File, dirContext?: AnyDirWithContext): Promise<ItemInfoResult> {
	return dirContext === undefined ? sdkApi.getItemInfo(item) : sdkApi.getItemInfo(item, dirContext)
}

// `enabled` lets a caller skip the fetch entirely rather than rely on a `.catch` to rescue it — the
// info dialog does this for a trashed item, since getItemPath/getDirSize stall rather than reject on
// a trashed item's unresolvable ancestry (see sdk.worker.ts's getItemInfo), and a stalled promise
// can't be caught. Defaults to true so every other caller is unaffected.
export function useItemInfoQuery(
	item: Dir | File,
	options?: { enabled?: boolean; dirContext?: AnyDirWithContext }
): UseQueryResult<ItemInfoResult> {
	return useQuery({
		queryKey: itemInfoQueryKey(item.uuid),
		queryFn: () => fetchItemInfo(item, options?.dirContext),
		enabled: options?.enabled ?? true
	})
}

// Per-directory recursive size aggregate (bytes + child file/dir counts), keyed on the directory's
// own uuid. One cache slice serves two consumers: the row size column (useDriveDirectorySizes
// prefetches a listing's directories under this exact key — see directoryListing.tsx) and, at sort
// time, the size sort. Deliberately NOT folded into itemInfo — that op also walks getItemPath, dead
// weight for bulk size prefetch; both resolve the same underlying getDirSize, so a directory read both
// ways (opening its info dialog after its row has already resolved a size) fetches twice, an accepted
// cost for keeping the size-only path path-walk-free and the info dialog's getItemPath/getDirSize
// trashed-item resilience (see sdk.worker.ts's getItemInfo) unentangled from the bulk prefetch path.
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

// Key + fn + freshness in ONE builder so useDirectorySizeQuery (a row) and prefetchQuery (the size-
// sort bridge) can never drift onto different keys — a prefetch under a mismatched key would fetch a
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
// something writes new content into it — upload.ts is the caller, right after a file lands. No active
// observer exists for a bare dirSize key (useDriveDirectorySizes prefetches, it never `useQuery`s per
// row — see that hook's own comment), so this only flags the entry stale; the next listing that shows
// this directory re-prefetches for real instead of serving pre-write bytes for the rest of
// DIRECTORY_SIZE_STALE_TIME. Root (null parent) has no dirSize entry of its own to invalidate.
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
