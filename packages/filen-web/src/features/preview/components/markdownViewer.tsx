import type { RefObject } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import type { TextState } from "@/features/preview/hooks/usePreviewTextFile"
import type { TextBuffer } from "@/features/preview/lib/textFile"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"

export interface MarkdownViewerProps {
	item: DriveItem
	alt: string
	// See RenderedSourceViewer's own props: they reach the source-mode editor only.
	editable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	contentRef?: RefObject<TextBuffer | null>
	locked?: boolean
	onTextState?: (state: TextState) => void
}

function renderMarkdown(source: RenderedSource, alt: string) {
	return (
		<PreviewMarkdown
			text={source.file.text}
			alt={alt}
		/>
	)
}

// A markdown file: rendered (math, images that are not loaded), with its source a toggle away.
// No parameter defaults: the React Compiler skips a component that has them.
export function MarkdownViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState }: MarkdownViewerProps) {
	return (
		<RenderedSourceViewer
			item={item}
			alt={alt}
			renderer={source => renderMarkdown(source, alt)}
			tag={codeMirrorLanguageFor(itemTypeExtension(item))}
			formatting
			{...(editable === undefined ? {} : { editable })}
			{...(onDirtyChange === undefined ? {} : { onDirtyChange })}
			{...(contentRef === undefined ? {} : { contentRef })}
			{...(locked === undefined ? {} : { locked })}
			{...(onTextState === undefined ? {} : { onTextState })}
		/>
	)
}
