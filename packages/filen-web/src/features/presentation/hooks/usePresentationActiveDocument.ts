import { useEffect } from "react"
import type { PresentationDocument, TextEditing } from "@filen/office/react/presentation"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { slidesDocumentReader } from "@/features/presentation/lib/slidesDocumentReader"
import type { SelectionReader } from "@/lib/activeDocument"

// The text selected in the body open in the slide's text editor (`text`), paragraphs as lines; nothing without one.
export function slideTextSelection(text: TextEditing): SelectionReader {
	const selected = (): string => {
		const state = text.active?.state

		if (state === undefined || state.selection.empty) {
			return ""
		}

		return state.doc.textBetween(state.selection.from, state.selection.to, "\n")
	}

	return {
		selectedChars: () => selected().length,
		selectedText: () => selected()
	}
}

// The deck shown (view or editor) published as the open document once its session is up: `current` is the slide in
// view (0-based). The reader asks the deck's worker; nothing is read until a reader asks. `selection` reads the user's
// selection (the viewer's slide text, the editor's body being edited); the editor passes its text editing (`text`) too,
// so the selection is measured as the body's state changes.
export function usePresentationActiveDocument(
	deck: PresentationDocument,
	current: number,
	editable: boolean,
	selection: SelectionReader,
	text?: TextEditing
): void {
	const session = deck.session
	const slides = deck.slides.length
	const selectionChanged = usePublishPreviewDocument(
		session === undefined
			? null
			: {
					kind: "slides",
					position: { slide: Math.min(current, Math.max(0, slides - 1)) + 1, slides },
					selection,
					editable,
					reader: slidesDocumentReader(session, slides)
				}
	)

	useEffect(() => text?.subscribe(selectionChanged), [text, selectionChanged])
}
