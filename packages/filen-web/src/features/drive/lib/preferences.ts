import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { type DriveSortBy } from "@/features/drive/lib/sort"

// The listing surfaces sort/view-mode preferences apply to — the NormalDirsAndFiles roots (My
// Drive, recents, favorites, trash, links), plus the two shared roots (sharedIn/sharedOut), which
// carry the widened DriveItem shape (see features/drive/lib/item.ts). links lists via the SDK's own
// listLinkedItems() (a NormalDirsAndFiles of the owned items that carry a public link), so its rows
// are plain directory/file arms just like the other flat roots.
export type DriveVariant = "drive" | "recents" | "favorites" | "trash" | "links" | "sharedIn" | "sharedOut"

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

const SORT_PREFERENCES_KV_KEY = "drive.sortPreferences.v1"

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

// kvGetJson already collapses "absent" and "schema-invalid" to null (see @/lib/storage/adapter) —
// the `?? DEFAULT` below is the self-heal: a corrupt persisted value is indistinguishable from no
// value at all, and both resolve to the same default.
export async function getSortPreferences(): Promise<DrivePreferences<DriveSortBy>> {
	return (await kvGetJson(SORT_PREFERENCES_KV_KEY, sortPreferencesSchema)) ?? DEFAULT_SORT_PREFERENCES
}

export async function setSortPreferences(next: DrivePreferences<DriveSortBy>): Promise<void> {
	await kvSetJson(SORT_PREFERENCES_KV_KEY, next)
}

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

// Pure mode flip — the caller persists the result via setSortPreferences. Turning perDirectory OFF
// deliberately leaves any existing perDirectory entries in place (only the "Reset sort" action below
// wipes them) so re-enabling the toggle later restores what the user had before, rather than
// silently discarding it on every off/on cycle.
export function withSortModeToggle(prefs: DrivePreferences<DriveSortBy>, perDirectory: boolean): DrivePreferences<DriveSortBy> {
	return { ...prefs, mode: perDirectory ? "perDirectory" : "global" }
}

// Pure reset — wipes the global order back to the app default AND every per-directory override,
// matching mobile's "Reset sort" action (screens/appearance.tsx): resets the global order and clears
// all saved per-directory overrides in one action, regardless of which mode is currently active.
export function resetSortPreferences(prefs: DrivePreferences<DriveSortBy>): DrivePreferences<DriveSortBy> {
	return { ...prefs, global: DEFAULT_SORT_PREFERENCES.global, perDirectory: {} }
}

export type DriveViewMode = "list" | "grid"

const VIEW_MODE_PREFERENCES_KV_KEY = "drive.viewModePreferences.v1"

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

export async function getViewModePreferences(): Promise<DrivePreferences<DriveViewMode>> {
	return (await kvGetJson(VIEW_MODE_PREFERENCES_KV_KEY, viewModePreferencesSchema)) ?? DEFAULT_VIEW_MODE_PREFERENCES
}

export async function setViewModePreferences(next: DrivePreferences<DriveViewMode>): Promise<void> {
	await kvSetJson(VIEW_MODE_PREFERENCES_KV_KEY, next)
}

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

// Same mode-flip/reset pair as the sort preferences above, mirroring mobile's "Remember view mode per
// directory" toggle + "Reset view" action (screens/appearance.tsx).
export function withViewModeModeToggle(prefs: DrivePreferences<DriveViewMode>, perDirectory: boolean): DrivePreferences<DriveViewMode> {
	return { ...prefs, mode: perDirectory ? "perDirectory" : "global" }
}

export function resetViewModePreferences(prefs: DrivePreferences<DriveViewMode>): DrivePreferences<DriveViewMode> {
	return { ...prefs, global: DEFAULT_VIEW_MODE_PREFERENCES.global, perDirectory: {} }
}
