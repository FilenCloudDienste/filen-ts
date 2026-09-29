import { type, type Type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import type { FlatListingKind } from "@/features/drive/lib/flatListing"
import { withoutKey } from "@/lib/utils"

// The listing surfaces sort/view-mode preferences apply to — the NormalDirsAndFiles roots (My
// Drive, recents, favorites, trash, links), plus the two shared roots (sharedIn/sharedOut), which
// carry the widened DriveItem shape (see features/drive/lib/item.ts). links lists via the SDK's own
// listLinkedItems() (a NormalDirsAndFiles of the owned items that carry a public link), so its rows
// are plain directory/file arms just like the other flat roots.
export type DriveVariant = "drive" | FlatListingKind | "sharedIn" | "sharedOut"

// Minimal location a preference is scoped to: which listing surface, and (for "drive") which
// directory within it. `uuid` is null for the three flat listings and for My Drive's own root.
export interface DriveLocation {
	variant: DriveVariant
	uuid: string | null
}

export function getPerDirectoryKey(location: DriveLocation): string {
	return `${location.variant}:${location.uuid ?? ""}`
}

export interface DrivePreferences<T extends string> {
	mode: "global" | "perDirectory"
	global: T
	perDirectory: Record<string, T>
}

// Pure mode flip — the caller persists the result. Turning perDirectory OFF deliberately leaves any
// existing perDirectory entries in place (only resetPreferences wipes them) so re-enabling the toggle
// later restores what the user had before, rather than silently discarding it on every off/on cycle.
export function withModeToggle<T extends string>(prefs: DrivePreferences<T>, perDirectory: boolean): DrivePreferences<T> {
	return { ...prefs, mode: perDirectory ? "perDirectory" : "global" }
}

// Pure reset — wipes the global value back to the app default AND every per-directory override,
// matching mobile's "Reset sort"/"Reset view" actions (screens/appearance.tsx), regardless of which
// mode is currently active.
export function resetPreferences<T extends string>(prefs: DrivePreferences<T>, defaultGlobal: T): DrivePreferences<T> {
	return { ...prefs, global: defaultGlobal, perDirectory: {} }
}

// Recents is a fixed chronological view (see resolveEffectiveSort) — no sort menu renders for it,
// and a selection made while viewing it must be a no-op rather than silently persisting somewhere
// the user never sees.
export function isSortableVariant(variant: DriveVariant): boolean {
	return variant !== "recents"
}

// Move relocates an item within the owned drive tree — meaningless in the links view, a cross-tree
// aggregation of every owned item that carries a public link (a "move" would silently reparent an
// item the user is viewing purely for its link). Gates MOVE out of both the per-item menu and the
// bulk bar for that variant alone; every other variant's move disposition is decided elsewhere
// (isReadOnlySharedVariant/trash), so this only ever subtracts links.
export function canMoveVariant(variant: DriveVariant): boolean {
	return variant !== "links"
}

// Whether the currently-browsed location accepts create/upload/drag-drop. "drive" always (My Drive's
// own navigable tree). A nested sharedOut directory (uuid !== null) too — the caller owns that
// directory, since sharedOut only ever lists items THEY shared out, so it's writable exactly like the
// identical directory reached via My Drive (see itemMenu.logic.ts's own ownerMutable gate for the
// matching per-item rationale). The sharedOut ROOT (uuid === null) is excluded: it's the virtual
// "everything I've shared out" aggregation, not a real directory with a parent to create into. Every
// other variant (recents/favorites/trash/links/sharedIn) has no owned/navigable parent to write into.
export function canWriteVariant(variant: DriveVariant, uuid: string | null): boolean {
	return variant === "drive" || (variant === "sharedOut" && uuid !== null)
}

// Annotated as `Type<DriveSortBy>` rather than cast: a literal added to/removed from DriveSortBy
// without a matching edit here fails to compile instead of silently under/over-accepting.
const driveSortBySchema: Type<DriveSortBy> = type(
	"'nameAsc'|'nameDesc'|'sizeAsc'|'sizeDesc'|'typeAsc'|'typeDesc'|'uploadDateAsc'|'uploadDateDesc'|'lastModifiedAsc'|'lastModifiedDesc'"
)

export const sortPreferencesSchema: Type<DrivePreferences<DriveSortBy>> = type({
	mode: "'global'|'perDirectory'",
	global: driveSortBySchema,
	perDirectory: { "[string]": driveSortBySchema }
})

export const DEFAULT_SORT_PREFERENCES: DrivePreferences<DriveSortBy> = {
	mode: "global",
	global: "nameAsc",
	perDirectory: {}
}

export const { get: getSortPreferences, set: setSortPreferences } = kvPreference({
	key: "drive.sortPreferences.v1",
	schema: sortPreferencesSchema,
	fallback: DEFAULT_SORT_PREFERENCES
})

export function resolveEffectiveSort(prefs: DrivePreferences<DriveSortBy>, location: DriveLocation): DriveSortBy {
	if (location.variant === "recents") {
		return "uploadDateDesc"
	}

	if (prefs.mode === "perDirectory") {
		return prefs.perDirectory[getPerDirectoryKey(location)] ?? "nameAsc"
	}

	return prefs.global
}

// Pure update — the caller persists the result via setSortPreferences. A no-op for recents (see
// isSortableVariant) so a stray selection event while viewing it can never write a preference no
// menu will ever surface again.
export function withSortSelection(
	prefs: DrivePreferences<DriveSortBy>,
	location: DriveLocation,
	next: DriveSortBy
): DrivePreferences<DriveSortBy> {
	if (!isSortableVariant(location.variant)) {
		return prefs
	}

	if (prefs.mode === "perDirectory") {
		return { ...prefs, perDirectory: { ...prefs.perDirectory, [getPerDirectoryKey(location)]: next } }
	}

	return { ...prefs, global: next }
}

// Pure update back to the default order where the user is: in per-directory mode only this location's
// entry goes (it then resolves to the default), otherwise the global order resets. A no-op for recents,
// same as withSortSelection.
export function withSortCleared(prefs: DrivePreferences<DriveSortBy>, location: DriveLocation): DrivePreferences<DriveSortBy> {
	if (!isSortableVariant(location.variant)) {
		return prefs
	}

	if (prefs.mode === "perDirectory") {
		const key = getPerDirectoryKey(location)

		return { ...prefs, perDirectory: withoutKey(prefs.perDirectory, key) }
	}

	return { ...prefs, global: DEFAULT_SORT_PREFERENCES.global }
}

export type DriveViewMode = "list" | "grid"

const driveViewModeSchema: Type<DriveViewMode> = type("'list'|'grid'")

export const viewModePreferencesSchema: Type<DrivePreferences<DriveViewMode>> = type({
	mode: "'global'|'perDirectory'",
	global: driveViewModeSchema,
	perDirectory: { "[string]": driveViewModeSchema }
})

export const DEFAULT_VIEW_MODE_PREFERENCES: DrivePreferences<DriveViewMode> = {
	mode: "global",
	global: "list",
	perDirectory: {}
}

export const { get: getViewModePreferences, set: setViewModePreferences } = kvPreference({
	key: "drive.viewModePreferences.v1",
	schema: viewModePreferencesSchema,
	fallback: DEFAULT_VIEW_MODE_PREFERENCES
})

// Unlike sort, view mode has no read-only variant — recents renders as list or grid same as any
// other listing — so this carries no variant special-case.
export function resolveEffectiveViewMode(prefs: DrivePreferences<DriveViewMode>, location: DriveLocation): DriveViewMode {
	if (prefs.mode === "perDirectory") {
		return prefs.perDirectory[getPerDirectoryKey(location)] ?? prefs.global
	}

	return prefs.global
}

export function withViewModeSelection(
	prefs: DrivePreferences<DriveViewMode>,
	location: DriveLocation,
	next: DriveViewMode
): DrivePreferences<DriveViewMode> {
	if (prefs.mode === "perDirectory") {
		return { ...prefs, perDirectory: { ...prefs.perDirectory, [getPerDirectoryKey(location)]: next } }
	}

	return { ...prefs, global: next }
}

const hideHiddenItemsSchema: Type<boolean> = type("boolean")

// Default OFF, deliberately unlike Finder and File Explorer (mobile parity). Those hide dot-prefixed
// entries out of the box because their users mostly did not create them; a Filen drive holds what its
// owner put there, so nothing is hidden until the owner asks for it. The toggle itself lives in the
// drive toolbar's Display menu (components/viewModeToggle.tsx); WHICH listings it applies to is
// lib/hiddenItems.ts's hiddenFilterAppliesTo.
export const DEFAULT_HIDE_HIDDEN_ITEMS = false

export const { get: getHideHiddenItems, set: setHideHiddenItems } = kvPreference({
	key: "drive.hideHiddenItems.v1",
	schema: hideHiddenItemsSchema,
	fallback: DEFAULT_HIDE_HIDDEN_ITEMS
})
