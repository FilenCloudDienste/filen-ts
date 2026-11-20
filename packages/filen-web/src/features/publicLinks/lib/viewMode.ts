import { type, type Type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import type { DriveViewMode } from "@/features/drive/lib/preferences"

// How a public directory's listing shows, list or grid: one choice for every link this browser opens, kept apart from
// the drive's own view preferences, so browsing someone's link never changes how the visitor's drive shows.
export const PUBLIC_VIEW_MODE_KV_KEY = "publicLinks.viewMode.v1"

export const DEFAULT_PUBLIC_VIEW_MODE: DriveViewMode = "list"

const publicViewModeSchema: Type<DriveViewMode> = type("'list'|'grid'")

export const { get: getPublicViewMode, set: setPublicViewMode } = kvPreference({
	key: PUBLIC_VIEW_MODE_KV_KEY,
	schema: publicViewModeSchema,
	fallback: DEFAULT_PUBLIC_VIEW_MODE
})
