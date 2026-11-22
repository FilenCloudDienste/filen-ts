import { useEffect, useSyncExternalStore } from "react"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { docxEditDocumentReader } from "@/features/preview/lib/documentReaders"
import type { DocxPageStore } from "@/features/preview/components/docxGoTo.logic"
import type { SelectionReader } from "@/lib/activeDocument"

// The Word document being edited, published as the open document: the page in view from the status bar's page store,
// the body's text by page through the editor, the selection through the editor's transform host, measured on the
// editor's selection events. Its own component, so a page scrolled into view re-renders it alone, never the editor.
export function DocxEditDocument({
	editor,
	pages,
	selection,
	editable
}: {
	editor: PagedEditor | undefined
	pages: DocxPageStore
	selection: SelectionReader
	editable: boolean
}) {
	const { page, count } = useSyncExternalStore(pages.subscribe, pages.get)
	const selectionChanged = usePublishPreviewDocument(
		editor === undefined
			? null
			: {
					kind: "docx",
					position: { page: Math.min(page + 1, Math.max(count, 1)), pages: count },
					selection,
					editable,
					reader: docxEditDocumentReader(editor)
				}
	)

	useEffect(
		() =>
			editor?.subscribe(event => {
				if (event.type === "selection" || event.type === "story") {
					selectionChanged()
				}
			}),
		[editor, selectionChanged]
	)

	return null
}
