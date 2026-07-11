import JSZip from "jszip"
import type { Note } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { i18n } from "@/lib/i18n"
import { downloadBlob } from "@/lib/downloadBlob"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { exportFilename, exportContent, exportMimeType, dedupeExportNames } from "@/features/notes/lib/export.logic"

// The impure shell around export.logic.ts's pure transforms: resolve a note's content, then trigger
// a real browser download. Never calls toast itself — same convention as lib/actions.ts, the caller
// (noteMenu.tsx / notesSidebar.tsx) resolves the outcome and surfaces `errorLabel(dto)`.

// Cache-first content read, same rationale as duplicateNote (lib/actions.ts): a note already open in
// the editor has its content warm, so exporting it costs no extra round trip. `?? ""` matches
// exportContent's own contract (a resolved string, never undefined) — an empty note exports as an
// empty file rather than throwing.
async function resolveContent(note: Note): Promise<string> {
	const cached = queryClient.getQueryData<string | undefined>(noteContentQueryKey(note.uuid))

	if (cached !== undefined) {
		return cached
	}

	return (await runOp(sdkApi.getNoteContent(note))) ?? ""
}

export async function exportNote(note: Note): Promise<VoidActionOutcome> {
	try {
		const raw = await resolveContent(note)
		const filename = exportFilename(note.title, note.noteType, i18n.t("notes:noteUntitled"))

		downloadBlob(filename, new Blob([exportContent(note.noteType, raw)], { type: exportMimeType(filename) }))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
}

// One Notes.zip, every non-trashed note as its own faithful file (D3) — content fetched via
// getNoteContent PER NOTE, SEQUENTIALLY (never Promise.all): the shared e2e account's note cap is a
// hard 10, but the real constraint is the same one runOp/the SDK worker apply everywhere else —
// concurrency/rate-limit policy is the SDK's job, never a JS-side parallel burst (CLAUDE.md). A
// trashed note is excluded (mirrors the menu's own "export" entry never appearing on the trashed
// variant, noteMenu.logic.ts).
export async function exportAllNotes(notes: readonly Note[]): Promise<VoidActionOutcome> {
	const exportable = notes.filter(note => !note.trash)

	if (exportable.length === 0) {
		return { status: "success" }
	}

	const fallbackTitle = i18n.t("notes:noteUntitled")
	const filenames = dedupeExportNames(exportable.map(note => exportFilename(note.title, note.noteType, fallbackTitle)))
	const zip = new JSZip()

	try {
		for (let index = 0; index < exportable.length; index += 1) {
			const note = exportable[index]
			const filename = filenames[index]

			if (note === undefined || filename === undefined) {
				continue
			}

			const raw = await resolveContent(note)

			zip.file(filename, exportContent(note.noteType, raw))
		}

		const blob = await zip.generateAsync({ type: "blob" })

		downloadBlob(i18n.t("notes:notesExportAllFilename"), blob)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
}
