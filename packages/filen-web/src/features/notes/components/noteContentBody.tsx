import { useTranslation } from "react-i18next"
import type { Note } from "@filen/sdk-rs"
import { useNoteEditor, type NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import { NoteTextCodeEditor } from "@/features/notes/components/noteTextCodeEditor"
import { NoteMarkdownEditor } from "@/features/notes/components/noteMarkdownEditor"
import { RichTextEditor } from "@/features/notes/components/editor/richTextEditor"
import { ChecklistEditor } from "@/features/notes/components/editor/checklistEditor"
import { NoteReaderByType } from "@/features/notes/components/reader/noteReaderByType"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"

// Per-type dispatch, once the editor controller has a seed to render. `noteType` is the wasm STRING
// union (never the uniffi enum object) — exhaustive over its 5 members so a future variant fails to
// compile until mapped. Every writable type has a live editor (CodeMirror for text/code/md, Quill for
// rich, the custom widget for checklist); a trashed / non-writable note (deriveEditorReadOnly) stays on
// its read-only reader. Each branch is keyed on remountKey so a real reseed remounts the editor/reader
// fresh — the EDITOR INVARIANT the seed-at-mount surfaces rely on.
function BodyByType({
	note,
	controller,
	hideCompletedChecklist
}: {
	note: Note
	controller: NoteEditorController
	hideCompletedChecklist: boolean
}) {
	if (controller.readOnly) {
		return (
			<NoteReaderByType
				key={controller.remountKey}
				note={note}
				content={controller.seed}
			/>
		)
	}

	switch (note.noteType) {
		case "text":
		case "code":
			return (
				<NoteTextCodeEditor
					key={controller.remountKey}
					note={note}
					controller={controller}
				/>
			)
		case "md":
			return (
				<NoteMarkdownEditor
					key={controller.remountKey}
					note={note}
					controller={controller}
				/>
			)
		case "rich":
			return (
				<RichTextEditor
					key={controller.remountKey}
					controller={controller}
				/>
			)
		case "checklist":
			return (
				<ChecklistEditor
					key={controller.remountKey}
					controller={controller}
					hideCompleted={hideCompletedChecklist}
				/>
			)
	}
}

// Content body for the editor card — mounted below noteEditorPane's title header. Owns the
// loading/error states derived by useNoteEditor (which itself decouples them from the deliberately
// disabled-while-inflight content query) and, once ready, dispatches to the matching editor/reader.
// Keyed by the caller on `note.uuid` (noteEditorPane.tsx) so switching notes rebuilds the controller.
export function NoteContentBody({
	note,
	hideCompletedChecklist = false
}: {
	note: Note
	// The editor header's persisted per-note "hide completed items" preference (noteEditorPane.tsx),
	// threaded down to the checklist branch only; every other type ignores it.
	hideCompletedChecklist?: boolean
}) {
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
				hideCompletedChecklist={hideCompletedChecklist}
			/>
		</div>
	)
}
