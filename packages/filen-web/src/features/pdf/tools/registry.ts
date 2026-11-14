import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import type { PdfToolAvailability, PdfToolClass, PdfWidgetSummary } from "@filen/office/core/pdfedit"
import type { PdfCommandName } from "@filen/office/dom/pdfedit"
import type { PdfViewport } from "@filen/office/dom/pdf"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { ActionDef } from "@/lib/keymap/registry"
import type { PreviewKey } from "@/lib/i18n"

// The PDF editor's tools, one module per feature (tools/<feature>.tool.tsx), each registered by one line in
// tools/index.ts. A tool says where it sits in the ribbon, its label and icon, its keys (collected into the pdfEditor
// keymap section, lib/keymap.ts), when it is offered, and what it does: an action tool runs once (`run`), a mode tool
// becomes the active tool and draws on the pages through its Overlay (and a side Panel). Everything it changes goes
// through the editor session's commands (dom/pdfedit/commands), so the swap from the viewer to the editor happens on
// its first use, with the input that started it kept and replayed.

export type PdfRibbonTab = "home" | "fillSign" | "pages" | "protect" | "tools"

export const PDF_RIBBON_TABS: readonly PdfRibbonTab[] = ["home", "fillSign", "pages", "protect", "tools"]

// What decides whether a tool is offered: may this file be edited here at all (canEditPdf, online), and, once the
// editor has the document, what its signatures and its author's restrictions allow. Before the swap `tools` is null:
// nothing is known to forbid yet, and the editor refuses what it must once it opens.
export interface PdfPolicyState {
	readonly editable: boolean
	readonly online: boolean
	readonly tools: PdfToolAvailability | null
}

// Offered, or not with the reason shown on the control.
export type PdfToolVerdict = { readonly enabled: true } | { readonly enabled: false; readonly reasonKey: PreviewKey }

// What a tool works with. `edit` runs `change` on the editor session, starting the editor first when the viewer still
// shows pdf.js (the change waits for it; a failure to start is shown by the host, never thrown here).
export interface PdfToolContext {
	edit(change: (session: PdfEditSessionModel) => Promise<unknown>): void
	// Ends the active mode tool (back to selection).
	finish(): void
}

export interface PdfToolOverlayProps {
	readonly context: PdfToolContext
	// 0-based page, and the viewport that maps its bottom-left user space to the page's box.
	readonly page: number
	readonly viewport: PdfViewport
	// The page's form widgets, once the editor has read them (null before the swap).
	readonly widgets: readonly PdfWidgetSummary[] | null
}

export interface PdfToolPanelProps {
	readonly context: PdfToolContext
}

export interface PdfTool {
	readonly id: string
	readonly ribbon: { readonly tab: PdfRibbonTab; readonly group: string; readonly order: number }
	readonly labelKey: PreviewKey
	readonly icon: LucideIcon
	// The kind of change it makes (the signature policy and the author's restrictions speak of these).
	readonly toolClass: PdfToolClass
	// Its keys: the ids it handles, defined in `actions` (registered in the pdfEditor section).
	readonly actionIds: readonly string[]
	readonly actions: readonly ActionDef[]
	readonly enabledWhen: (policy: PdfPolicyState) => PdfToolVerdict
	// The commands it dispatches (for review: a tool never changes the document any other way).
	readonly commands: readonly PdfCommandName[]
	// An action tool runs once; without `run` it is a mode tool, active until finished.
	readonly run?: (context: PdfToolContext) => void
	readonly Overlay?: ComponentType<PdfToolOverlayProps>
	readonly Panel?: ComponentType<PdfToolPanelProps>
}

// The usual rule: offered where the file may be edited and the document allows the tool's kind of change.
export function toolEnabled(toolClass: PdfToolClass, policy: PdfPolicyState): PdfToolVerdict {
	if (!policy.editable) return { enabled: false, reasonKey: "previewPdfToolNotEditable" }
	if (!policy.online) return { enabled: false, reasonKey: "previewPdfToolOffline" }

	const block = policy.tools?.[toolClass] ?? null

	if (block === "signed") return { enabled: false, reasonKey: "previewPdfToolSigned" }
	if (block === "restricted") return { enabled: false, reasonKey: "previewPdfOwnerRestricted" }

	return { enabled: true }
}

// The tools of a ribbon tab in their groups' order, then their own.
export function toolsOfTab(tools: readonly PdfTool[], tab: PdfRibbonTab): PdfTool[] {
	return tools.filter(tool => tool.ribbon.tab === tab).sort((a, b) => a.ribbon.order - b.ribbon.order)
}
