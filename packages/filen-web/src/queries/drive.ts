import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
// Whole-statement `import type` here too — sdk.worker.ts's own top-level code pulls in
// @filen/sdk-rs as a real value import, same elision hazard as above.
import type { ListDirectoryTarget } from "@/workers/sdk.worker"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import {
	getSortPreferences,
	getViewModePreferences,
	type DrivePreferences,
	type DriveVariant,
	type DriveViewMode
} from "@/lib/drive/preferences"
import { type DriveSortBy } from "@/lib/drive/sort"

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
// listings); every other variant ignores `uuid` entirely — recents/favorites/trash are always
// their own flat listing regardless of how the caller got there.
function toListingTarget(variant: DriveVariant, uuid: string | null): ListDirectoryTarget {
	if (variant !== "drive") {
		return { kind: variant }
	}

	return uuid === null ? { kind: "root" } : { kind: "uuid", uuid }
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
export function useDirectoryListingQuery(variant: DriveVariant, uuid: string | null): UseQueryResult<DriveItem[]> {
	return useQuery({
		queryKey: driveListingQueryKey({ variant, uuid }),
		queryFn: () => fetchDirectoryListing(variant, uuid)
	})
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
// (see lib/drive/navigate.ts's splatToUuids) — this only resolves DISPLAY NAMES for that path's
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

// Sort/view-mode preferences live in kv storage (lib/drive/preferences.ts), not the SDK — reading
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
