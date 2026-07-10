import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

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
