import type { RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxDocument } from "@filen/office/react/docx"
import { DocxReflow, type DocxEditorHandle, type DocxEditorInteractions, type DocxEditorMark } from "@filen/office/react/docx/editor"

export interface DocxReflowSurfaceProps {
	editor: PagedEditor
	// The renderer's side of the same document (its media).
	document: DocxDocument
	// The same handle the paged editor fills (clipboard, hit tests, touch selection).
	handleRef: RefObject<DocxEditorHandle | null>
	label: string
	// The id of the element describing the editing area (none read-only).
	describedBy?: string
	readOnly: boolean
	apple: boolean
	marks: readonly DocxEditorMark[]
	onFind: () => void
	// Presses on objects in the text (comment highlights, controls), as on the pages.
	interactions?: DocxEditorInteractions
}

// The document reflowed to the window's width for editing on phones and narrow windows, in place of the
// pages: the text wraps to the screen, tracked changes show inline, comments as highlights.
const STORY_LABELS = {
	footnote: "previewDocxMobileFootnote",
	endnote: "previewDocxMobileEndnote",
	textbox: "previewDocxMobileTextBox"
} as const
// A note with its mark as numbered ("Footnote 3").
const NUMBERED_LABELS = { footnote: "previewDocxMobileFootnoteNumbered", endnote: "previewDocxMobileEndnoteNumbered" } as const

export function DocxReflowSurface({ handleRef, interactions, ...props }: DocxReflowSurfaceProps) {
	const { t } = useTranslation("preview")

	return (
		<DocxReflow
			ref={handleRef}
			editor={props.editor}
			document={props.document}
			className="size-full"
			label={props.label}
			{...(props.describedBy === undefined ? {} : { describedBy: props.describedBy })}
			readOnly={props.readOnly}
			apple={props.apple}
			marks={props.marks}
			onFind={props.onFind}
			storyLabel={(kind, mark) => (kind === "textbox" || mark === "" ? t(STORY_LABELS[kind]) : t(NUMBERED_LABELS[kind], { mark }))}
			{...(interactions === undefined ? {} : { interactions })}
		/>
	)
}
