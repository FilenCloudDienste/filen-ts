import type { RootDotFilenFilter } from "@filen/shared"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import type { DriveItem } from "@/features/drive/lib/item"

// Pure rule only — the kv preference itself lives with the other drive preferences
// (lib/preferences.ts's getHideHiddenItems/setHideHiddenItems), so the render path that imports this
// never pulls storage into its module graph. isHiddenName/isHiddenSearchPath/filterHiddenItems live
// in @filen/shared.

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

// Where the root `.filen` can appear while its own setting hides it: My Drive's root (and a search rooted there) and
// the flat listings that gather items from anywhere. A subdirectory can't hold it, and the trash keeps a trashed one
// restorable, so neither pays for the filter.
export function dotFilenFilterAppliesTo(variant: DriveVariant, uuid: string | null): boolean {
	switch (variant) {
		case "drive":
			return uuid === null
		case "recents":
		case "favorites":
		case "links":
			return true
		default:
			return false
	}
}

// The flat listings that surface `.filen`'s own files (settings, playlists, chat uploads) next to the user's.
function showsDotFilenContents(variant: DriveVariant): boolean {
	return variant === "recents" || variant === "favorites"
}

function directoryParentOf(item: DriveItem): string | null {
	return item.type === "directory" ? item.data.parent : null
}

// The shared filter's root `.filen` rule against the drive root `rootUuid`; undefined (nothing hidden) when the root
// `.filen` is shown here or the root isn't known yet. `searchAtDriveRoot`: search results come from a search rooted
// there. `isSystemDir` (lib/dotFilen.ts's isDotFilenSystemDir) names `.filen` and the subdirectories resolved so far,
// whose items recents and favorites drop too.
export function rootDotFilenFilter({
	rootUuid,
	variant,
	searchAtDriveRoot,
	isSystemDir
}: {
	rootUuid: string | null
	variant: DriveVariant
	searchAtDriveRoot: boolean
	isSystemDir?: ((uuid: string) => boolean) | undefined
}): RootDotFilenFilter<DriveItem> | undefined {
	if (rootUuid === null) {
		return undefined
	}

	return {
		rootUuid,
		directoryParentOf,
		searchAtDriveRoot,
		insideDotFilen: isSystemDir !== undefined && showsDotFilenContents(variant) ? item => isSystemDir(item.data.parent) : undefined
	}
}
