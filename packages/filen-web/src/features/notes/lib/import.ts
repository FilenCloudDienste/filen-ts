import type { Note } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { queryClient } from "@/queries/client"
import { notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { sync } from "@/features/notes/lib/sync"
import { retypeNewNote } from "@/features/notes/lib/actions"
import { detectImportNoteType, sanitizeImportedContent, titleFromFilename } from "@/features/notes/lib/import.logic"
import { exceedsNoteSizeCap } from "@/features/notes/hooks/useNoteEditor.logic"
import { attemptOp, type ActionOutcome } from "@/lib/actions/outcome"

// Import Note: reads a picked file's text, detects its note type from the extension
// (import.logic.ts), creates a note titled from the file name, flips it to
// the detected type when it differs from the SDK's own "text" default, and seeds its content through
// the SAME fault-tolerant outbox the live editor writes through — never a raw one-off SDK content call
// — so an import that lands offline still durably queues and eventually pushes exactly like a typed
// edit would.
export async function importNoteFromFile(file: File): Promise<ActionOutcome<Note>> {
	const noteType = detectImportNoteType(file.name)

	if (noteType === undefined) {
		return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteImportUnsupportedType")) }
	}

	const read = await attemptOp(file.text())

	if (read.status === "error") {
		return read
	}

	const content = sanitizeImportedContent(noteType, read.item)

	// The editor's own cap: a push past it is rejected server-side, so the note would stay empty on
	// every device while this tab's cache showed the text. Checked before anything is created.
	if (exceedsNoteSizeCap(content)) {
		return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteImportTooLarge")) }
	}

	const title = titleFromFilename(file.name)

	let created = await attemptOp(sdkApi.createNote(title))

	if (created.status === "success" && created.item.noteType !== noteType) {
		created = await attemptOp(retypeNewNote(created.item, noteType))
	}

	if (created.status === "error") {
		return created
	}

	const note = created.item

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
