import type { RefObject } from "react"
import type { PreviewTextFile } from "@/features/preview/hooks/usePreviewTextFile"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { readWholeText } from "@/features/preview/lib/documentReaders"
import type { TextBuffer, TextFile } from "@/features/preview/lib/textFile"
import type { SelectionReader } from "@/lib/activeDocument"

const BOM = "﻿"

// The text as it now is: the editor's buffer while it edits (contentRef, flattened only when read), else the file as
// decoded.
export function heldText(buffer: TextBuffer | null | undefined, file: TextFile): string {
	if (buffer === null || buffer === undefined) {
		return file.text
	}

	const text = buffer.text()

	return text.startsWith(BOM) ? text.slice(BOM.length) : text
}

// A text viewer's file published as the open document once decoded (`publishes`: this viewer's kind is one), with the
// selection `selection` reads (its editor's, or the rendered view's).
export function usePreviewTextDocument(
	text: PreviewTextFile,
	contentRef: RefObject<TextBuffer | null> | undefined,
	editable: boolean,
	publishes: boolean,
	selection: SelectionReader
): void {
	usePublishPreviewDocument(
		publishes && text.status === "success"
			? {
					kind: "text",
					position: {},
					selection,
					editable: editable && text.writable,
					// Inline, not textDocumentReader(): the buffer's ref is read only when a reader reads.
					reader: {
						units: () => Promise.resolve(1),
						text: (_range, signal, maxChars) => readWholeText(() => heldText(contentRef?.current, text.file), signal, maxChars)
					}
				}
			: null
	)
}
