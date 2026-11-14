import { PDF_RIBBON_TABS, toolsOfTab, type PdfPolicyState, type PdfRibbonTab, type PdfTool } from "@/features/pdf/tools/registry"
import type { PreviewKey } from "@/lib/i18n"

// The PDF ribbon's layout: its tabs, and a tab's tools gathered into their groups.

export const PDF_TAB_LABELS: Record<PdfRibbonTab, PreviewKey> = {
	home: "previewPdfTabHome",
	fillSign: "previewPdfTabFillSign",
	pages: "previewPdfTabPages",
	protect: "previewPdfTabProtect",
	tools: "previewPdfTabTools"
}

export function pdfRibbonTab(value: string): PdfRibbonTab | null {
	return PDF_RIBBON_TABS.find(tab => tab === value) ?? null
}

export interface PdfToolGroup {
	readonly id: string
	readonly tools: readonly PdfTool[]
}

// A tab's tools by `ribbon.group`, the groups in the order of their first tool, each group's tools in theirs.
export function pdfToolGroups(tools: readonly PdfTool[], tab: PdfRibbonTab): PdfToolGroup[] {
	const groups = new Map<string, PdfTool[]>()

	for (const tool of toolsOfTab(tools, tab)) {
		const group = groups.get(tool.ribbon.group)

		if (group === undefined) {
			groups.set(tool.ribbon.group, [tool])
		} else {
			group.push(tool)
		}
	}

	return Array.from(groups, ([id, members]) => ({ id, tools: members }))
}

// Groups with a name of their own; any other is named after its first tool.
const GROUP_LABELS: ReadonlyMap<string, PreviewKey> = new Map([
	["form", "previewPdfRibbonGroupForm"],
	["annotate", "previewPdfRibbonGroupAnnotate"],
	["comment", "previewPdfRibbonGroupComment"],
	["pagesInsert", "previewPdfPagesInsert"],
	["pagesPage", "previewPdfPagesToolbarLabel"],
	["redact", "previewPdfRedactMode"]
])

export function pdfToolGroupLabelKey(group: PdfToolGroup): PreviewKey | null {
	return GROUP_LABELS.get(group.id) ?? group.tools[0]?.labelKey ?? null
}

export interface PdfToolControl {
	// Why it is not offered, null when it is.
	readonly reasonKey: PreviewKey | null
	// A mode tool is pressed while it is the active tool; an action tool never is.
	readonly pressed: boolean | undefined
}

export function pdfToolControl(tool: PdfTool, policy: PdfPolicyState, activeTool: string | null): PdfToolControl {
	const verdict = tool.enabledWhen(policy)

	return {
		reasonKey: verdict.enabled ? null : verdict.reasonKey,
		pressed: tool.idle === true ? activeTool === null : tool.run === undefined ? activeTool === tool.id : undefined
	}
}

// What choosing a mode tool makes the active tool: it, or nothing when it already was (pressed again, it finishes).
// The idle tool is chosen by ending the active one.
export function nextActiveTool(tool: PdfTool, activeTool: string | null): string | null {
	return tool.idle === true || activeTool === tool.id ? null : tool.id
}
