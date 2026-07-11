import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import type { NoteType } from "@filen/sdk-rs"

// The sidebar's two-view toggle, persisted with the same kv-backed convention drive's view mode uses
// (features/drive/lib/preferences.ts): a single global value, arktype-validated on read, self-healing
// to the default on any absent/corrupt value. Mirrors mobile's secure-store `notesViewMode` key
// (01-DECISIONS D4). Unlike drive's view mode this carries no per-directory scope — notes has one
// sidebar, not a per-listing surface.
export type NotesViewMode = "notes" | "tags"

const NOTES_VIEW_MODE_KV_KEY = "notes.viewMode.v1"

const notesViewModeSchema: Type<NotesViewMode> = type("'notes'|'tags'")

export const DEFAULT_NOTES_VIEW_MODE: NotesViewMode = "notes"

// kvGetJson collapses "absent" and "schema-invalid" to null (see @/lib/storage/adapter); the `??`
// default is the self-heal, same rule as getViewModePreferences.
export async function getNotesViewMode(): Promise<NotesViewMode> {
	return (await kvGetJson(NOTES_VIEW_MODE_KV_KEY, notesViewModeSchema)) ?? DEFAULT_NOTES_VIEW_MODE
}

export async function setNotesViewMode(next: NotesViewMode): Promise<void> {
	await kvSetJson(NOTES_VIEW_MODE_KV_KEY, next)
}

// md split-pane preview ratio (01-DECISIONS D1 "md ALSO gets the split live preview... ratio persisted
// per the preferences convention") — one global value, same kv-backed shape as the view mode above.
// Clamped well inside [0,1] so a drag never collapses either pane to zero width.
const MD_SPLIT_RATIO_KV_KEY = "notes.mdSplitRatio.v1"

const mdSplitRatioSchema: Type<number> = type("number")

export const DEFAULT_MD_SPLIT_RATIO = 0.5
export const MD_SPLIT_RATIO_MIN = 0.2
export const MD_SPLIT_RATIO_MAX = 0.8

export function clampMdSplitRatio(ratio: number): number {
	return Math.min(MD_SPLIT_RATIO_MAX, Math.max(MD_SPLIT_RATIO_MIN, ratio))
}

export async function getMdSplitRatio(): Promise<number> {
	const stored = await kvGetJson(MD_SPLIT_RATIO_KV_KEY, mdSplitRatioSchema)

	return stored === null ? DEFAULT_MD_SPLIT_RATIO : clampMdSplitRatio(stored)
}

export async function setMdSplitRatio(ratio: number): Promise<void> {
	await kvSetJson(MD_SPLIT_RATIO_KV_KEY, clampMdSplitRatio(ratio))
}

// The persisted default-note-type preference (oldweb-notes §1: create always calls createNote() first —
// the SDK's own default is "text" — then setNoteType only if this preference differs). No settings UI
// exists yet (old-web's own Settings → General dropdown lands later); the key is persisted from day one
// so a future settings control has somewhere real to read/write.
const DEFAULT_NOTE_TYPE_KV_KEY = "notes.defaultNoteType.v1"

const defaultNoteTypeSchema: Type<NoteType> = type("'text'|'md'|'code'|'rich'|'checklist'")

export const DEFAULT_NOTE_TYPE: NoteType = "text"

export async function getDefaultNoteType(): Promise<NoteType> {
	return (await kvGetJson(DEFAULT_NOTE_TYPE_KV_KEY, defaultNoteTypeSchema)) ?? DEFAULT_NOTE_TYPE
}

export async function setDefaultNoteType(next: NoteType): Promise<void> {
	await kvSetJson(DEFAULT_NOTE_TYPE_KV_KEY, next)
}
