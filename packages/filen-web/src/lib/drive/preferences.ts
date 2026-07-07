import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { type DriveSortBy } from "@/lib/drive/sort"

// The four listing surfaces sort/view-mode preferences apply to — the NormalDirsAndFiles roots
// (My Drive, recents, favorites, trash). sharedIn/sharedOut/links carry a different item shape
// entirely and are not part of this surface yet.
export type DriveVariant = "drive" | "recents" | "favorites" | "trash"

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
