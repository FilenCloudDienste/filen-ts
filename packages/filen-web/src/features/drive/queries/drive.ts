import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
// Whole-statement `import type` here too — sdk.worker.ts's own top-level code pulls in
// @filen/sdk-rs as a real value import, same elision hazard as above.
import type { ListDirectoryTarget, ItemInfoResult } from "@/workers/sdk.worker"
import type { Dir, File, FileVersion, DirPublicLinkRW, FilePublicLink, AnyDirWithContext } from "@filen/sdk-rs"
import { narrowItem, asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import {
	getSortPreferences,
	getViewModePreferences,
	type DrivePreferences,
	type DriveVariant,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import { type DriveSortBy } from "@/features/drive/lib/sort"

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

// Root only applies to the "drive" variant (client.root() has no equivalent for the three flat
// listings); recents/favorites/trash are always their own flat listing regardless of how the caller
// got there. The two shared variants list through their own worker ops (different result shapes — see
// fetchSharedListing), never listDirectory, so they have no target here.
export function toListingTarget(variant: DriveVariant, uuid: string | null): ListDirectoryTarget {
	switch (variant) {
		case "drive":
			return uuid === null ? { kind: "root" } : { kind: "uuid", uuid }
		case "recents":
		case "favorites":
		case "trash":
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
	queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: parentUuid }), prev => updater(prev ?? []))
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
