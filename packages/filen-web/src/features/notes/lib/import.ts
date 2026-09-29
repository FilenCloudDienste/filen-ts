import type { Note } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { sync } from "@/features/notes/lib/sync"
import { retypeNewNote } from "@/features/notes/lib/actions"
import { detectImportNoteType, sanitizeImportedContent, titleFromFilename } from "@/features/notes/lib/import.logic"
import { exceedsNoteSizeCap } from "@/features/notes/hooks/useNoteEditor.logic"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"

// Import Note: reads a picked file's text, detects its note type from the extension
// (import.logic.ts), creates a note titled from the file name, flips it to
// the detected type when it differs from the SDK's own "text" default, and seeds its content through
// the SAME fault-tolerant outbox the live editor writes through — never a raw one-off SDK content call
// — so an import that lands offline still durably queues and eventually pushes exactly like a typed
// edit would.
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

	// The editor's own cap: a push past it is rejected server-side, so the note would stay empty on
	// every device while this tab's cache showed the text. Checked before anything is created.
	if (exceedsNoteSizeCap(content)) {
		const message = i18n.t("notes:noteImportTooLarge")

		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	const title = titleFromFilename(file.name)

	let note: Note

	try {
		note = await runOp(sdkApi.createNote(title))

		if (note.noteType !== noteType) {
			note = await retypeNewNote(note, noteType)
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
