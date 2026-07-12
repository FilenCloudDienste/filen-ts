import type { Note } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { sync } from "@/features/notes/lib/sync"
import { detectImportNoteType, sanitizeImportedContent, titleFromFilename } from "@/features/notes/lib/import.logic"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"

// Import Note: reads a picked file's text, detects its note type from the extension
// (import.logic.ts), creates a note titled from the file name, flips it to
// the detected type when it differs from the SDK's own "text" default, and seeds its content through
// the SAME fault-tolerant outbox the live editor writes through — never a raw one-off SDK content call
// — so an import that lands offline still durably queues and eventually pushes exactly like a typed
// edit would. Bypasses createNote()'s own default-note-type PREFERENCE deliberately: an imported note's
// type is dictated by the file it came from, not by what the user last picked for a blank note.
export async function importNoteFromFile(file: File): Promise<ActionOutcome<Note>> {
	const noteType = detectImportNoteType(file.name)

	if (noteType === undefined) {
		const message = i18n.t("notes:noteImportUnsupportedType")

		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	let rawText: string

	try {
		rawText = await file.text()
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const content = sanitizeImportedContent(noteType, rawText)
	const title = titleFromFilename(file.name)

	let note: Note

	try {
		note = await runOp(sdkApi.createNote(title))

		if (note.noteType !== noteType) {
			note = await runOp(sdkApi.setNoteType(note, noteType))
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(note)

	// Durable enqueue + an immediate flush attempt (best-effort — the outbox itself guarantees eventual
	// delivery even if this particular flush loses to a dropped connection). The content cache is seeded
	// synchronously right after so the editor the caller opens next shows the imported text at once,
	// without waiting on the outbox round trip.
	await sync.enqueue(note, content)
	sync.executeNow()
	queryClient.setQueryData(noteContentQueryKey(note.uuid), content)

	return { status: "success", item: note }
}
