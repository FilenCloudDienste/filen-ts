import { useTranslation } from "react-i18next"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import type { TextViewerProps } from "@/features/preview/components/textViewer"
import { MermaidFileDiagram } from "@/features/preview/components/mermaidDiagram"

function renderDiagram(source: RenderedSource) {
	return <MermaidFileDiagram source={source.file.text} />
}

// A Mermaid file (.mmd, .mermaid): its diagram in the zoomable picture surface, its source a toggle away.
// No parameter defaults: the React Compiler skips a component that has them.
export function MermaidViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState, readAs }: TextViewerProps) {
	const { t } = useTranslation("preview")

	return (
		<RenderedSourceViewer
			item={item}
			alt={alt}
			renderer={renderDiagram}
			tag={codeMirrorLanguageFor(itemTypeExtension(item))}
			formatting={false}
			labels={{ view: t("previewMermaidView"), rendered: t("previewCommandBarRendered") }}
			{...(editable === undefined ? {} : { editable })}
			{...(onDirtyChange === undefined ? {} : { onDirtyChange })}
			{...(contentRef === undefined ? {} : { contentRef })}
			{...(locked === undefined ? {} : { locked })}
			{...(onTextState === undefined ? {} : { onTextState })}
			{...(readAs === undefined ? {} : { readAs })}
		/>
	)
}
