import type { Note } from "@filen/sdk-rs"
import type { InflightEntry } from "@/features/notes/store/useNotesInflight"

// old-web parity: the client-side note-content cap. A push past this would be rejected server-side and
// wedge the note, so the editor blocks the ENQUEUE past the cap (never the keystroke — CodeMirror keeps
// the text on screen) and surfaces a size-reached indicator instead. 1 MiB minus a 64-byte headroom
// for the encryption envelope the SDK wraps the content in.
export const MAX_NOTE_SIZE = 1024 * 1024 - 64

// One shared encoder — measuring by UTF-8 byte length (not JS string length) so a note full of
// multibyte characters is capped by what actually crosses the wire, matching the server's own budget.
const encoder = new TextEncoder()

export function noteContentByteSize(value: string): number {
	return encoder.encode(value).length
}

export function exceedsNoteSizeCap(value: string): boolean {
	return noteContentByteSize(value) > MAX_NOTE_SIZE
}

// The freshest inflight entry's content for a note, or null when the outbox holds nothing for it. The
// outbox is a time-ordered list per uuid (it collapses to one entry in steady state); the seed wants
// the newest by LOCAL author-time, the same entry the push loop sends.
export function latestInflightContent(entries: InflightEntry[] | undefined): string | null {
	if (!entries || entries.length === 0) {
		return null
	}

	let latest: InflightEntry | null = null

	for (const entry of entries) {
		if (!latest || entry.timestamp > latest.timestamp) {
			latest = entry
		}
	}

	return latest ? latest.content : null
}

// THE seed-priority rule (mobile content/index.tsx editorSeed): an unsynced inflight edit wins over the
// content query's data — a cold open with a disk-restored queue must paint the user's own typed text,
// never stale pre-edit content. Falls through to the query's content, then the empty string (a
// freshly-created note has no content yet). Read once at mount; the editor freezes it there and only a
// remount-key change may reseed (the EDITOR INVARIANT).
export function deriveEditorSeed({
	inflightLatest,
	queryContent
}: {
	inflightLatest: string | null
	queryContent: string | undefined
}): string {
	if (inflightLatest !== null) {
		return inflightLatest
	}

	return queryContent ?? ""
}

// The editor's remount key. `dataUpdatedAt` cannot advance while the note has an inflight entry (its
// content query is disabled-while-inflight, noteContent.ts), so this key is FROZEN across an editing
// session and the editor never remounts mid-edit and wipes the cursor. It only changes on a real
// reseed event: a different note (uuid) or a completed fetch for a note with no pending edits.
export function deriveEditorRemountKey({ uuid, dataUpdatedAt }: { uuid: string; dataUpdatedAt: number }): string {
	return `${uuid}:${String(dataUpdatedAt)}`
}

// Read-only derivation. For now only a trashed note is read-only; a non-writable participant (a shared
// note without write permission) folds in here once participants land, mirroring mobile's hasWriteAccess.
export function deriveEditorReadOnly(note: Note): boolean {
	return note.trash
}

export type EditorLoadState = "pending" | "error" | "ready"

// Decouple the editor's load state from the deliberately-disabled content query (mobile
// computeNoteLoading): when the note has an inflight entry the query is disabled and stays `pending`
// FOREVER, but we already have a seed to render — so inflight is always immediately "ready". Only with
// NO inflight does the query's own pending/error surface as the editor's load state.
export function deriveEditorLoadState({
	hasInflight,
	queryStatus
}: {
	hasInflight: boolean
	queryStatus: EditorLoadState
}): EditorLoadState {
	if (hasInflight) {
		return "ready"
	}

	if (queryStatus === "pending") {
		return "pending"
	}

	if (queryStatus === "error") {
		return "error"
	}

	return "ready"
}
