import { type DriveVariant } from "@/features/drive/lib/preferences"

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
