import type { Note, NoteType } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { queryClient } from "@/queries/client"
import { notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { sync } from "@/features/notes/lib/sync"
import { retypeNewNote } from "@/features/notes/lib/actions"
import { discardPartialNote } from "@/features/notes/lib/socketHandlers"
import { detectImportNoteType, sanitizeImportedContent, titleFromFilename } from "@/features/notes/lib/import.logic"
import { exceedsNoteSizeCap, MAX_NOTE_SIZE } from "@/features/notes/hooks/useNoteEditor.logic"
import { readTextFileDetected } from "@/features/preview/lib/encodingGuess"
import { attemptOp, type ActionOutcome } from "@/lib/actions/outcome"

// Files no import can fit under the cap, rejected from their size before a byte is read. A text, Markdown or code note
// is the file's decoded text, which is at least a quarter of the file's size in UTF-8 (UTF-32 ASCII, after a 4-byte
// mark); the exact check runs after decoding. Sanitizing drops scripts, styles and images wholesale, so a saved web page several
// times the cap can still fit: rich files are bounded only by what the tab can safely parse.
const MAX_PLAIN_IMPORT_BYTES = MAX_NOTE_SIZE * 4 + 4
const MAX_RICH_IMPORT_BYTES = 32 * 1024 * 1024

// Import Note: reads a picked file's text (in the encoding it was saved in, detected as the text preview does), detects
// its note type from the extension (import.logic.ts), creates a note titled from the file name, flips it to
// the detected type when it differs from the SDK's own "text" default, and seeds its content through
// the SAME fault-tolerant outbox the live editor writes through — never a raw one-off SDK content call
// — so an import that lands offline still durably queues and eventually pushes exactly like a typed
// edit would.
export async function importNoteFromFile(file: File): Promise<ActionOutcome<Note>> {
	const noteType = detectImportNoteType(file.name)

	if (noteType === undefined) {
		return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteImportUnsupportedType")) }
	}

	if (file.size > (noteType === "rich" ? MAX_RICH_IMPORT_BYTES : MAX_PLAIN_IMPORT_BYTES)) {
		return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteImportTooLarge")) }
	}

	const read = await attemptOp(file.arrayBuffer())

	if (read.status === "error") {
		return read
	}

	// The text keeps the file's own line endings; only a byte order mark is dropped.
	const content = sanitizeImportedContent(noteType, (await readTextFileDetected(new Uint8Array(read.item))).text)

	// The editor's own cap: a push past it is rejected server-side, so the note would stay empty on
	// every device while this tab's cache showed the text. Checked before anything is created.
	if (exceedsNoteSizeCap(content)) {
		return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteImportTooLarge")) }
	}

	return createNoteWithContent(titleFromFilename(file.name), noteType, content)
}

// A note created with a title, a type and its first content, as Import Note and the assistant create one: the type
// flipped from the SDK's own "text" default when it differs, and the content seeded through the SAME fault-tolerant
// outbox the live editor writes through — never a raw one-off SDK content call — so a note created offline still
// durably queues and eventually pushes exactly like a typed edit would. `content` is already in the type's stored
// form and within the size cap.
export async function createNoteWithContent(title: string, noteType: NoteType, content: string): Promise<ActionOutcome<Note>> {
	const created = await attemptOp(sdkApi.createNote(title))

	if (created.status === "error") {
		return created
	}

	let note = created.item

	if (note.noteType !== noteType) {
		const retyped = await attemptOp(retypeNewNote(note, noteType))

		// A note left in the wrong type would show its content's markup as text (or its Markdown unrendered): it is
		// removed, so a retry does not leave a stray behind.
		if (retyped.status === "error") {
			await discardPartialNote(note)

			return retyped
		}

		note = retyped.item
	}

	notesQueryUpsert(note)

	// Durable enqueue + an immediate flush attempt (best-effort — the outbox itself guarantees eventual
	// delivery even if this particular flush loses to a dropped connection). The content cache is seeded
	// synchronously right after so the editor opened next shows the text at once, without waiting on the
	// outbox round trip.
	await sync.enqueue(note, content)
	sync.executeNow()
	queryClient.setQueryData(noteContentQueryKey(note.uuid), content)

	return { status: "success", item: note }
}
