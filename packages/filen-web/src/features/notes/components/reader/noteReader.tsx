import { useTranslation } from "react-i18next"
import { useNoteContent } from "@/features/notes/hooks/useNoteContent"
import { TextCodeReader } from "@/features/notes/components/reader/textCodeReader"
import { MarkdownReader } from "@/features/notes/components/reader/markdownReader"
import { RichReader } from "@/features/notes/components/reader/richReader"
import { ChecklistReader } from "@/features/notes/components/reader/checklistReader"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"
import type { Note } from "@filen/sdk-rs"

// Per-type read-only dispatch, once content has loaded. `noteType` is the wasm STRING union (never the
// uniffi enum object) — exhaustive over its 5 members so a future variant fails to compile until mapped.
function ReaderByType({ note, content }: { note: Note; content: string }) {
	switch (note.noteType) {
		case "text":
		case "code":
			return (
				<TextCodeReader
					note={note}
					content={content}
				/>
			)
		case "md":
			return (
				<MarkdownReader
					note={note}
					content={content}
				/>
			)
		case "rich":
			return <RichReader content={content} />
		case "checklist":
			return <ChecklistReader content={content} />
	}
}

// Content body for the editor card — mounted below noteEditorPane's title header. Owns the
// loading/error states for the note's own content query (useNoteContent) and, once resolved, dispatches
// to the matching read-only renderer. Keyed by the caller on `note.uuid` (noteEditorPane.tsx) so
// switching notes remounts every reader fresh — required by the EDITOR INVARIANT the CodeMirror-backed
// readers rely on (their own `content` state freezes at mount, per codeMirrorSource.tsx).
export function NoteReader({ note }: { note: Note }) {
	const { t } = useTranslation("notes")
	const result = useNoteContent(note)

	if (result.status === "pending") {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
				<Spinner className="size-5" />
				<p className="text-sm">{t("notesLoadingNote")}</p>
			</div>
		)
	}

	if (result.status === "error") {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
				<p className="text-sm font-medium">{t("notesContentLoadError")}</p>
				<p className="text-sm text-muted-foreground">{errorLabel(result.dto)}</p>
			</div>
		)
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ReaderByType
				note={note}
				content={result.content}
			/>
		</div>
	)
}
