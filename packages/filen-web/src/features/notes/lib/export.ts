import type { Note } from "@filen/sdk-rs"
import JSZip from "jszip"
import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadBlob } from "@/lib/downloadBlob"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { VoidActionOutcome } from "@/lib/actions/outcome"
import { resolveLocalFirstContent, noteUndecryptableError } from "@/features/notes/lib/localContent"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import { exportFilename, exportContent, exportMimeType, dedupeExportNames } from "@/features/notes/lib/export.logic"

// The impure shell around export.logic.ts's pure transforms: resolve a note's content, then trigger
// a real browser download. The exports themselves never toast — same convention as lib/actions.ts, the
// caller (noteMenu.tsx / notesSidebar.tsx) resolves the outcome (toastNotesExportOutcome for an archive).

export async function exportNote(note: Note): Promise<VoidActionOutcome> {
	try {
		const result = await resolveLocalFirstContent(note)

		if (result.status === "undecryptable") {
			return { status: "error", dto: noteUndecryptableError() }
		}

		const filename = exportFilename(note.title, note.noteType, i18n.t("notes:noteUntitled"))

		downloadBlob(filename, new Blob([exportContent(note.noteType, result.content)], { type: exportMimeType(filename) }))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
}

// `skipped` counts the notes that carried no readable content — either their metadata never decrypted
// (no title either) or their body's ciphertext did not. The caller surfaces the count so a smaller
// archive than expected is never silent.
export type ExportAllOutcome = { status: "success"; skipped: number } | { status: "error"; dto: ErrorDTO }

// One Notes.zip, every non-trashed note as its own faithful file — content fetched via
// getNoteContent PER NOTE, SEQUENTIALLY (never Promise.all): the shared e2e account's note cap is a
// hard 10, but the real constraint is the same one runOp/the SDK worker apply everywhere else —
// concurrency/rate-limit policy is the SDK's job, never a JS-side parallel burst (CLAUDE.md). A
// trashed note is excluded (mirrors the menu's own "export" entry never appearing on the trashed
// variant, noteMenu.logic.ts), and so is an undecryptable one (the per-note menu suppresses Export for
// those; a walk over every note must mirror that instead of zipping an empty file under a placeholder
// name).
export async function exportAllNotes(notes: readonly Note[]): Promise<ExportAllOutcome> {
	const exportable = notes.filter(note => !note.trash && !isNoteUndecryptable(note))
	let skipped = notes.filter(note => !note.trash).length - exportable.length

	if (exportable.length === 0) {
		return { status: "success", skipped }
	}

	const fallbackTitle = i18n.t("notes:noteUntitled")
	const filenames = dedupeExportNames(exportable.map(note => exportFilename(note.title, note.noteType, fallbackTitle)))
	let written = 0

	try {
		const zip = new JSZip()

		for (let index = 0; index < exportable.length; index += 1) {
			const note = exportable[index]
			const filename = filenames[index]

			if (note === undefined || filename === undefined) {
				continue
			}

			const result = await resolveLocalFirstContent(note)

			if (result.status === "undecryptable") {
				skipped += 1

				continue
			}

			zip.file(filename, exportContent(note.noteType, result.content))
			written += 1
		}

		// Every note skipped: produce no archive at all rather than an empty one the user would take
		// for a backup.
		if (written === 0) {
			return { status: "success", skipped }
		}

		const blob = await zip.generateAsync({ type: "blob" })

		downloadBlob(i18n.t("notes:notesExportAllFilename"), blob)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success", skipped }
}

// A file save, not a server write: no activity toast, only what went wrong or was left out.
export function toastNotesExportOutcome(outcome: ExportAllOutcome): void {
	if (outcome.status === "error") {
		toast.error(errorLabel(outcome.dto))

		return
	}

	if (outcome.skipped > 0) {
		toast.warning(i18n.t("notes:notesExportSkippedUndecryptable", { count: outcome.skipped }))
	}
}
