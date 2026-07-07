import { useQuery, type UseQueryResult } from "@tanstack/react-query"
// Whole-statement `import type` (not the usual inline `type` keyword — see every other
// @filen/sdk-rs type import in this codebase, e.g. lib/drive/item.ts): the inline form doesn't
// reliably elide under vitest for this package, and a non-elided import drags in the wasm-bindgen
// worker glue (references `self`, undefined under Node).
import type { Dir } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
// Whole-statement `import type` here too — sdk.worker.ts's own top-level code pulls in
// @filen/sdk-rs as a real value import, same elision hazard as above.
import type { ListDirectoryTarget } from "@/workers/sdk.worker"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"

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

// Every ancestor (and the current directory) narrows to the "directory" arm by construction —
// getItemPath only ever returns Dir values — but narrowItem's signature covers Dir | File, so this
// throw-guards the arm instead of casting it away.
type DriveDirectoryItem = Extract<DriveItem, { type: "directory" }>

function narrowDirectory(dir: Dir): DriveDirectoryItem {
	const item = narrowItem(dir)
	if (item.type !== "directory") {
		throw new Error("narrowItem(Dir) produced a non-directory arm")
	}
	return item
}

export interface DirectoryPath {
	path: string
	ancestors: DriveDirectoryItem[]
	current: DriveDirectoryItem
}

// Root has no ancestors and is never queried here (Root is not a valid getItemPath argument) — the
// breadcrumb renders the variant's own root label directly and skips this call whenever uuid is
// null (see components/drive/breadcrumb.tsx). A rejection here (not-found uuid, or the SDK's
// undecryptable-ancestor case) surfaces as a normal query error; there is no partial/degraded path.
export async function fetchDirectoryPath(uuid: string): Promise<DirectoryPath> {
	const result = await sdkApi.getDirectoryPath(uuid)
	return {
		path: result.path,
		ancestors: result.ancestors.map(narrowDirectory),
		current: narrowDirectory(result.current)
	}
}

export function useDirectoryPathQuery(uuid: string | null): UseQueryResult<DirectoryPath> {
	return useQuery({
		queryKey: ["drive", "path", { uuid }] as const,
		enabled: uuid !== null,
		queryFn: () => {
			// Never reached while uuid is null (enabled:false above) — this is the guard/throw
			// narrowing this codebase uses instead of a bare non-null assertion or `as string`.
			if (uuid === null) {
				throw new Error("useDirectoryPathQuery requires a non-null uuid")
			}
			return fetchDirectoryPath(uuid)
		}
	})
}
