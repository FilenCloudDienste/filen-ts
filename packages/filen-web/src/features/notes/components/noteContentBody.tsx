import { useTranslation } from "react-i18next"
import type { Note } from "@filen/sdk-rs"
import { useNoteEditor, type NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import { NoteTextCodeEditor } from "@/features/notes/components/noteTextCodeEditor"
import { NoteMarkdownEditor } from "@/features/notes/components/noteMarkdownEditor"
import { TextCodeReader } from "@/features/notes/components/reader/textCodeReader"
import { MarkdownReader } from "@/features/notes/components/reader/markdownReader"
import { RichReader } from "@/features/notes/components/reader/richReader"
import { ChecklistReader } from "@/features/notes/components/reader/checklistReader"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"

// Per-type dispatch, once the editor controller has a seed to render. `noteType` is the wasm STRING
// union (never the uniffi enum object) — exhaustive over its 5 members so a future variant fails to
// compile until mapped. text/code/md are the live CodeMirror editors this step; a trashed note stays
// read-only (deriveEditorReadOnly); rich/checklist stay read-only readers until the next step. Each
// branch is keyed on remountKey so a real reseed remounts the editor/reader fresh — the EDITOR
// INVARIANT the CodeMirror-backed surfaces rely on (their `content` state freezes at mount).
function BodyByType({ note, controller }: { note: Note; controller: NoteEditorController }) {
	switch (note.noteType) {
		case "text":
		case "code":
			return controller.readOnly ? (
				<TextCodeReader
					key={controller.remountKey}
					note={note}
					content={controller.seed}
				/>
			) : (
				<NoteTextCodeEditor
					key={controller.remountKey}
					note={note}
					controller={controller}
				/>
			)
		case "md":
			return controller.readOnly ? (
				<MarkdownReader
					key={controller.remountKey}
					note={note}
					content={controller.seed}
				/>
			) : (
				<NoteMarkdownEditor
					key={controller.remountKey}
					note={note}
					controller={controller}
				/>
			)
		case "rich":
			return (
				<RichReader
					key={controller.remountKey}
					content={controller.seed}
				/>
			)
		case "checklist":
			return (
				<ChecklistReader
					key={controller.remountKey}
					content={controller.seed}
				/>
			)
	}
}

// Content body for the editor card — mounted below noteEditorPane's title header. Owns the
// loading/error states derived by useNoteEditor (which itself decouples them from the deliberately
// disabled-while-inflight content query) and, once ready, dispatches to the matching editor/reader.
// Keyed by the caller on `note.uuid` (noteEditorPane.tsx) so switching notes rebuilds the controller.
export function NoteContentBody({ note }: { note: Note }) {
	const { t } = useTranslation("notes")
	const controller = useNoteEditor(note)

	if (controller.status === "pending") {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
				<Spinner className="size-5" />
				<p className="text-sm">{t("notesLoadingNote")}</p>
			</div>
		)
	}

	if (controller.status === "error") {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
				<p className="text-sm font-medium">{t("notesContentLoadError")}</p>
				{controller.errorDto !== undefined ? (
					<p className="text-sm text-muted-foreground">{errorLabel(controller.errorDto)}</p>
				) : null}
			</div>
		)
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{controller.sizeReached ? (
				<p
					role="status"
					className="shrink-0 border-b border-border/50 bg-destructive/10 px-5 py-2 text-sm text-destructive"
				>
					{t("noteSizeLimitReached")}
				</p>
			) : null}
			<BodyByType
				note={note}
				controller={controller}
			/>
		</div>
	)
}
