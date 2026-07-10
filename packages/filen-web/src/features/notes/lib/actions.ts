import { sdkApi } from "@/lib/sdk/client"
import { notesQueryUpsert } from "@/features/notes/queries/notes"
import type { Note } from "@filen/sdk-rs"

// Minimal create: the SDK creates a note (text type by default), then the returned row is patched into
// the notes list cache (confirm-then-patch, queries/client.ts) so the sidebar shows it without waiting
// for a refetch. The full create flow — persisted default-note-type application (oldweb-notes §1) — is
// the actions wave's concern; this shell only needs a note to exist and be navigable.
export async function createNote(): Promise<Note> {
	const note = await sdkApi.createNote()

	notesQueryUpsert(note)

	return note
}
