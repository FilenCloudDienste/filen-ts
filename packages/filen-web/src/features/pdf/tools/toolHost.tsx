import type { PdfViewport } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { isMupdfDocument } from "@filen/office/react/pdfedit"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import type { PdfEditView } from "@/features/pdf/session/usePdfEdit"
import { PDF_TOOLS } from "@/features/pdf/tools"
import { toolInEffect, toolVariant, type PdfToolPanelSlot } from "@/features/pdf/tools/registry"

// Where the viewer mounts the tools: the tool in effect's Overlay on each page (the idle tool's while none is active),
// and every tool's Panel in its slot (beside the pages, or above them).

export function PdfToolOverlay({
	edit,
	document,
	page,
	viewport
}: {
	edit: PdfEditView
	document: PdfDomDocument
	// 1-based, as the page column numbers them.
	page: number
	viewport: PdfViewport
}) {
	const tool = toolInEffect(PDF_TOOLS, edit.activeTool)
	const Overlay = tool?.Overlay

	if (tool === undefined || Overlay === undefined) return null

	return (
		<Overlay
			context={edit.toolContext}
			page={page - 1}
			viewport={viewport}
			widgets={edit.snapshot?.widgets.get(page - 1) ?? null}
			editing={edit.phase.kind === "editing" && isMupdfDocument(document)}
			document={document}
			variant={toolVariant(tool, edit.toolVariants[tool.id])?.id ?? null}
		/>
	)
}

export function PdfToolPanels({ edit, document, slot }: { edit: PdfEditView; document: PdfDomDocument; slot: PdfToolPanelSlot }) {
	const phone = usePhoneWidth()

	return PDF_TOOLS.map(tool =>
		tool.Panel === undefined || (tool.panelSlot ?? "side") !== slot ? null : (
			<tool.Panel
				key={tool.id}
				context={edit.toolContext}
				document={document}
				active={edit.activeTool === tool.id}
				phone={phone}
			/>
		)
	)
}
