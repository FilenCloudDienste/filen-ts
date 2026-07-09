import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { resolveDriveNavigationTarget, type DriveNavigationTarget } from "@/features/drive/lib/navigate"
import { type SearchHitDTO } from "@/workers/searchEngine"

// Pure bits pulled out of use-drive-search.ts's async/timer-driven wiring so they're table-testable
// without a worker, Comlink, or React.

// Which async action a change in the toolbar's active/inactive state should trigger — "active" is
// input.trim() !== "". No timers or Comlink calls here; the hook owns those.
export type SearchTransition = "none" | "open" | "close" | "retune"

export function resolveSearchTransition(wasActive: boolean, isActive: boolean): SearchTransition {
	if (!wasActive && isActive) {
		return "open"
	}

	if (wasActive && !isActive) {
		return "close"
	}

	if (wasActive && isActive) {
		return "retune"
	}

	return "none"
}

export interface SearchResults {
	items: DriveItem[]
	// uuid -> the SDK's own "/"-joined ancestor-NAME chain from the search root down to the item's
	// parent (empty for a direct child of the root) — display-only breadcrumb text, never a navigation
	// path (splat segments are uuids, not names — see searchHitNavigationTarget below).
	parentPaths: ReadonlyMap<string, string>
}

// Raw hits arrive in whatever order the SDK's window delivers them. narrowItem is the SAME per-item
// mapper the existing listing query's queryFn uses (queries/drive.ts's fetchDirectoryListing), so a
// search hit becomes a DriveItem through the identical path a normal listing row does. parentPath has
// no home on DriveItem itself, so it rides alongside in a uuid-keyed map instead of being forced onto
// the item shape.
export function buildSearchResults(hits: readonly SearchHitDTO[]): SearchResults {
	const items: DriveItem[] = []
	const parentPaths = new Map<string, string>()

	for (const hit of hits) {
		const item = narrowItem(hit.item)

		items.push(item)
		parentPaths.set(item.data.uuid, hit.parentPath)
	}

	return { items, parentPaths }
}

// A directory hit is found via a ROOT-rooted recursive search, so opening it always lands directly
// inside it — never appended to whatever directory the toolbar happened to be showing when the search
// started (searchOpen's rootUuid is the drive root, not the "current" directory). Passing an empty
// splat (never the listing's own current splat) is what makes resolveDriveNavigationTarget compute
// that fresh, root-relative path instead of nesting under the current position. The hit's parentPath
// is names, not uuids (see buildSearchResults) — the target is rebuilt from the hit's own uuid instead
// of ever being composed from it.
export function searchHitNavigationTarget(item: DriveItem, variant: DriveVariant): DriveNavigationTarget | null {
	return resolveDriveNavigationTarget(item, variant, "")
}
