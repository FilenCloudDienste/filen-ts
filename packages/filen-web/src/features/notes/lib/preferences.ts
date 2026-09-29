import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { kvPreference } from "@/lib/storage/preference"
import { splitterKeyValue, type SplitterKeyBounds } from "@/lib/useSeparatorValue.logic"
import { NOTE_TAGS_SORT_OPTIONS, DEFAULT_NOTE_TAGS_SORT_BY, type NoteTagsSortBy } from "@filen/shared"

// The sidebar's two-view toggle, persisted with the same kv-backed convention drive's view mode uses
// (features/drive/lib/preferences.ts): a single global value, arktype-validated on read, self-healing
// to the default on any absent/corrupt value. Mirrors mobile's secure-store `notesViewMode` key.
// Unlike drive's view mode this carries no per-directory scope — notes has one
// sidebar, not a per-listing surface.
export type NotesViewMode = "notes" | "tags"

const notesViewModeSchema: Type<NotesViewMode> = type("'notes'|'tags'")

export const DEFAULT_NOTES_VIEW_MODE: NotesViewMode = "notes"

export const { get: getNotesViewMode, set: setNotesViewMode } = kvPreference({
	key: "notes.viewMode.v1",
	schema: notesViewModeSchema,
	fallback: DEFAULT_NOTES_VIEW_MODE
})

// md split-pane preview ratio — md notes also get the split live-preview layout, and the ratio is
// persisted, one global value, same kv-backed shape as the view mode above.
// Clamped well inside [0,1] so a drag never collapses either pane to zero width.
const mdSplitRatioSchema: Type<number> = type("number")

export const DEFAULT_MD_SPLIT_RATIO = 0.5
export const MD_SPLIT_RATIO_MIN = 0.2
export const MD_SPLIT_RATIO_MAX = 0.8

export function clampMdSplitRatio(ratio: number): number {
	return Math.min(MD_SPLIT_RATIO_MAX, Math.max(MD_SPLIT_RATIO_MIN, ratio))
}

export const MD_SPLIT_RATIO_STEP = 0.05

const MD_SPLIT_RATIO_KEY_BOUNDS: SplitterKeyBounds = { step: MD_SPLIT_RATIO_STEP, min: MD_SPLIT_RATIO_MIN, max: MD_SPLIT_RATIO_MAX }

// ArrowRight widens the left pane.
export function ratioFromKey(key: string, ratio: number): number | null {
	return splitterKeyValue(key, ratio, MD_SPLIT_RATIO_KEY_BOUNDS)
}

export const { get: getMdSplitRatio, set: setMdSplitRatio } = kvPreference({
	key: "notes.mdSplitRatio.v1",
	schema: mdSplitRatioSchema,
	fallback: DEFAULT_MD_SPLIT_RATIO,
	normalize: clampMdSplitRatio
})

// The tags-view sort order — sortNoteTags (sort.ts) has always been ported+tested, but the view
// hardcoded DEFAULT_NOTE_TAGS_SORT_BY with no control; this is the persisted preference an actual
// sort-menu control reads/writes. Same single-global-value kv shape as the view mode above.
const tagsSortBySchema: Type<NoteTagsSortBy> = type.enumerated(...NOTE_TAGS_SORT_OPTIONS)

export const { get: getNoteTagsSortBy, set: setNoteTagsSortBy } = kvPreference({
	key: "notes.tagsSortBy.v1",
	schema: tagsSortBySchema,
	fallback: DEFAULT_NOTE_TAGS_SORT_BY
})

// Per-note "hide completed checklist items" view preference — Record<noteUuid, boolean>, absent
// entry defaults to false (show everything). Purely a rendering filter (checklistEditor.tsx never edits
// the underlying content because of it); persisted globally under one kv key, same Record-keyed-by-uuid
// shape mobile's own secure-store entry uses.
const HIDE_COMPLETED_CHECKLIST_KV_KEY = "notes.hideCompletedChecklist.v1"

const hideCompletedChecklistSchema: Type<Record<string, boolean>> = type({ "[string]": "boolean" })

export async function getHideCompletedChecklist(noteUuid: string): Promise<boolean> {
	const record = await kvGetJson(HIDE_COMPLETED_CHECKLIST_KV_KEY, hideCompletedChecklistSchema)

	return record?.[noteUuid] ?? false
}

export async function setHideCompletedChecklist(noteUuid: string, hide: boolean): Promise<void> {
	const record = (await kvGetJson(HIDE_COMPLETED_CHECKLIST_KV_KEY, hideCompletedChecklistSchema)) ?? {}

	await kvSetJson(HIDE_COMPLETED_CHECKLIST_KV_KEY, { ...record, [noteUuid]: hide })
}
