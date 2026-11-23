import { useEffect, useRef, useState } from "react"
import type { EditorView } from "@codemirror/view"
import { useTranslation } from "react-i18next"
import { IN_EDITORS, OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { useCodeMirrorTransformHost } from "@/features/preview/lib/codeMirrorTransformHost"
import { SelectionTransformRoot } from "@/features/assistant/transform/selectionTransform"
import { usePublishNoteDocument } from "@/features/notes/hooks/usePublishNoteDocument"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { MarkdownViewSwitch } from "@/features/preview/components/markdownViewSwitch"
import { useLivePreview } from "@/features/preview/hooks/useLivePreview"
import { getMarkdownView, livePreviewFits, setMarkdownView, type MarkdownViewChoice } from "@/features/preview/lib/markdownView"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import type { Note } from "@filen/sdk-rs"

// In the editor too; never under a dialog or menu, which keeps the key.
const TOGGLE_OPTIONS = { ...IN_EDITORS, ...OUTSIDE_OVERLAYS }

// Writable md note editor, viewed as the file preview's markdown is (markdownView.ts, the device's one choice): Live
// preview or Source in the one editor (lib/livePreview, switched in place), or Read, the rendered note. The editor
// stays mounted, hidden, while reading: its buffer is the note's (seeded once, EDITOR INVARIANT), so Read renders the
// value last typed and returning picks up where the cursor was. The CALLER keys this on controller.remountKey, so a
// real reseed remounts it all.
//
// editor.togglePreview switches Read on and off, editor.toggleLivePreview Live preview and Source.
export function NoteMarkdownEditor({ note, controller }: { note: Note; controller: NoteEditorController }) {
	const { t } = useTranslation("preview")
	const [choice, setChoice] = useState<MarkdownViewChoice>(getMarkdownView)
	// What Read shows: the buffer as it was when Read was entered (nothing is typed while reading).
	const [readValue, setReadValue] = useState(controller.seed)
	const latestValueRef = useRef(controller.seed)
	const { host, onView } = useCodeMirrorTransformHost()
	const livePreview = useLivePreview("plain")
	// A note is at most 1 MiB, within live preview's size; checked on the seed all the same.
	const [liveAvailable] = useState(() => livePreviewFits(controller.seed))
	const editMode = liveAvailable ? choice.edit : "source"
	const viewRef = useRef<EditorView | null>(null)
	// Leaving Read: the editor takes focus back (hidden, it lost it), once it shows again.
	const refocusRef = useRef(false)

	usePublishNoteDocument(note, host)

	useEffect(() => {
		if (refocusRef.current && !choice.read) {
			refocusRef.current = false
			viewRef.current?.focus()
		}
	}, [choice.read])

	const handleView = (view: EditorView | null): void => {
		viewRef.current = view
		onView(view)
	}

	const choose = (next: MarkdownViewChoice): void => {
		if (next.read) {
			setReadValue(latestValueRef.current)
		} else if (choice.read) {
			refocusRef.current = true
		}

		setChoice(next)
		setMarkdownView(next)
	}

	useAction(
		"editor.togglePreview",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			choose({ edit: choice.edit, read: !choice.read })
		},
		TOGGLE_OPTIONS
	)

	useAction(
		"editor.toggleLivePreview",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (liveAvailable) {
				choose({ edit: editMode === "live" ? "source" : "live", read: false })
			}
		},
		TOGGLE_OPTIONS
	)

	function handleChange(value: string): void {
		latestValueRef.current = value
		controller.onChange(value)
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-end gap-1 px-3 py-1">
				<MarkdownViewSwitch
					reading={choice.read}
					editMode={editMode}
					liveAvailable={liveAvailable}
					readLocked={false}
					onRead={read => {
						choose({ edit: choice.edit, read })
					}}
					onEditMode={edit => {
						choose({ edit, read: false })
					}}
					viewLabel={t("previewCommandBarMarkdownView")}
				/>
			</div>
			{livePreview.node}
			<div className={choice.read ? "hidden" : "min-h-0 flex-1"}>
				<SelectionTransformRoot
					host={host}
					className="contents"
				>
					<CodeMirrorSource
						text={controller.seed}
						tag="markdown"
						alt={note.title ?? ""}
						editable
						onValueChange={handleChange}
						onView={handleView}
						livePreview={editMode === "live" ? livePreview.extension : null}
					/>
				</SelectionTransformRoot>
			</div>
			{choice.read ? (
				<div className="min-h-0 flex-1">
					<MarkdownRenderer
						text={readValue}
						alt={note.title ?? ""}
					/>
				</div>
			) : null}
		</div>
	)
}
