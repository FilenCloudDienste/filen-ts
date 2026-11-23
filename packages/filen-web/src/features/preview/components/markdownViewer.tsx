import type { RefObject } from "react"
import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import type { TextState } from "@/features/preview/hooks/usePreviewTextFile"
import type { TextBuffer } from "@/features/preview/lib/textFile"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import { useLivePreview } from "@/features/preview/hooks/useLivePreview"
import { MermaidScopeContext } from "@/features/preview/lib/mermaidScope"

export interface MarkdownViewerProps {
	item: DriveItem
	alt: string
	// See RenderedSourceViewer's own props: they reach the source-mode editor only.
	editable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	contentRef?: RefObject<TextBuffer | null>
	locked?: boolean
	onTextState?: (state: TextState) => void
	// The codepage this version is known to be in (this open saved it so): read without asking the detector again.
	readAs?: string | null
}

function renderMarkdown(source: RenderedSource, alt: string) {
	return (
		<PreviewMarkdown
			text={source.file.text}
			alt={alt}
		/>
	)
}

// A markdown file: edited in live preview or as source, or read rendered (math, images that are not loaded); an editable
// file opens in the device's choice, a read-only one in Read (markdownView.ts).
// No parameter defaults: the React Compiler skips a component that has them.
export function MarkdownViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState, readAs }: MarkdownViewerProps) {
	const { t } = useTranslation("preview")
	const livePreview = useLivePreview("preview")

	// The Read view draws its diagrams in the live preview's frame (PreviewMarkdown takes an outer scope): one a document.
	return (
		<MermaidScopeContext value={livePreview.mermaidScope}>
			<RenderedSourceViewer
				item={item}
				alt={alt}
				renderer={source => renderMarkdown(source, alt)}
				tag={codeMirrorLanguageFor(itemTypeExtension(item))}
				formatting
				publishes
				livePreview={livePreview}
				labels={{ view: t("previewCommandBarMarkdownView"), rendered: t("previewCommandBarRendered") }}
				{...(editable === undefined ? {} : { editable })}
				{...(onDirtyChange === undefined ? {} : { onDirtyChange })}
				{...(contentRef === undefined ? {} : { contentRef })}
				{...(locked === undefined ? {} : { locked })}
				{...(onTextState === undefined ? {} : { onTextState })}
				{...(readAs === undefined ? {} : { readAs })}
			/>
		</MermaidScopeContext>
	)
}
