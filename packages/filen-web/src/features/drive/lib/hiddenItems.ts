import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"

// Pure rules only — the kv preference itself lives with the other drive preferences
// (lib/preferences.ts's getHideHiddenItems/setHideHiddenItems), so the render path that imports this
// never pulls storage into its module graph.

// The dot-prefix convention. Leading whitespace is trimmed first: a name created by another client
// can carry it, and " .env" is the same hidden file to a user.
export function isHiddenName(name: string): boolean {
	return name.trim().startsWith(".")
}

// Whether a search hit lives inside a hidden directory. `parentPath` is the SDK's "/"-joined chain of
// ancestor NAMES relative to the search root (empty for a direct child) — search is recursive, so
// filtering on the hit's own name alone would hide `.thumbs` from the browser while flooding the
// results with everything inside it.
export function isHiddenSearchPath(parentPath: string): boolean {
	return parentPath.split("/").some(isHiddenName)
}

// Display-only filter, applied where a listing RENDERS, never where it is fetched: the query cache
// stays complete, so flipping the toggle re-renders instead of refetching and every consumer that
// reasons about what is really in a directory (transfers, socket updaters, bulk actions) is
// untouched. Judges an item by the name the row actually displays (decryptedMeta?.name ?? uuid), so
// an undecryptable item — whose display name is its uuid — always stays visible: hiding something the
// user cannot even identify would leave them no way to find it again.
export function filterHiddenDriveItems({
	items,
	hide,
	searchParentPaths
}: {
	items: DriveItem[]
	hide: boolean
	searchParentPaths?: ReadonlyMap<string, string>
}): DriveItem[] {
	if (!hide) {
		return items
	}

	return items.filter(item => {
		if (isHiddenName(item.data.decryptedMeta?.name ?? item.data.uuid)) {
			return false
		}

		const parentPath = searchParentPaths?.get(item.data.uuid)

		return parentPath === undefined || !isHiddenSearchPath(parentPath)
	})
}

// WHICH surfaces the preference applies to — an exhaustive Record, not a deny-list, so a new variant
// must make the call explicitly. Mirrors mobile's HIDDEN_FILTER_BY_DRIVE_PATH_TYPE: the two surfaces
// you BROWSE your own content on, and nothing else — never a picker, never trash/links, never content
// someone shared with you.
const HIDDEN_FILTER_BY_VARIANT: Record<DriveVariant, boolean> = {
	drive: true,
	recents: true,
	favorites: false,
	trash: false,
	links: false,
	sharedIn: false,
	sharedOut: false
}

export function hiddenFilterAppliesTo(variant: DriveVariant): boolean {
	return HIDDEN_FILTER_BY_VARIANT[variant]
}
