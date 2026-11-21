import type { RefObject } from "react"
import type { PreviewTextFile } from "@/features/preview/hooks/usePreviewTextFile"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { readWholeText } from "@/features/preview/lib/documentReaders"
import type { TextBuffer, TextFile } from "@/features/preview/lib/textFile"

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

// A text viewer's file published as the open document once decoded (`publishes`: this viewer's kind is one).
export function usePreviewTextDocument(
	text: PreviewTextFile,
	contentRef: RefObject<TextBuffer | null> | undefined,
	editable: boolean,
	publishes: boolean
): void {
	usePublishPreviewDocument(
		publishes && text.status === "success"
			? {
					kind: "text",
					position: {},
					selection: null,
					editable: editable && text.writable,
					// Inline, not textDocumentReader(): the buffer's ref is read only when a reader reads.
					reader: {
						units: () => Promise.resolve(1),
						text: (range, signal, maxChars) =>
							readWholeText(() => heldText(contentRef?.current, text.file), range, signal, maxChars)
					}
				}
			: null
	)
}
