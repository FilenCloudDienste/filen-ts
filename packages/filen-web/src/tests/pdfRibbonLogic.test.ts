import { describe, expect, it } from "vitest"
import { EraserIcon } from "lucide-react"
import { toolEnabled, type PdfPolicyState, type PdfRibbonTab, type PdfTool } from "@/features/pdf/tools/registry"
import { nextActiveTool, pdfRibbonTab, pdfToolControl, pdfToolGroupLabelKey, pdfToolGroups } from "@/features/pdf/ribbon/pdfRibbon.logic"
import type { PreviewKey } from "@/lib/i18n"

// The PDF ribbon's layout: a tab's tools in their groups, each control's offered state and pressed state.

function tool(id: string, tab: PdfRibbonTab, group: string, order: number, labelKey: PreviewKey, mode: boolean): PdfTool {
	const base: PdfTool = {
		id,
		ribbon: { tab, group, order },
		labelKey,
		icon: EraserIcon,
		toolClass: "formFill",
		actionIds: [],
		actions: [],
		enabledWhen: policy => toolEnabled("formFill", policy),
		commands: []
	}

	return mode ? base : { ...base, run: () => undefined }
}

const TOOLS: readonly PdfTool[] = [
	tool("draw", "home", "markup", 20, "previewPdfUndo", true),
	tool("reset", "fillSign", "form", 900, "previewPdfClearForm", false),
	tool("text", "home", "insert", 10, "previewPdfRedo", true),
	tool("highlight", "home", "markup", 15, "previewPdfSave", true),
	tool("ocr", "tools", "ocr", 1, "previewPdfSaveAsCopy", false)
]

const OPEN: PdfPolicyState = { editable: true, online: true, tools: null }

describe("pdfToolGroups", () => {
	it("gathers a tab's tools into groups in the order of their first tool", () => {
		const groups = pdfToolGroups(TOOLS, "home")

		expect(groups.map(group => group.id)).toEqual(["insert", "markup"])
		expect(groups[1]?.tools.map(entry => entry.id)).toEqual(["highlight", "draw"])
	})

	it("leaves a tab with no tools empty", () => {
		expect(pdfToolGroups(TOOLS, "protect")).toEqual([])
		expect(pdfToolGroups([], "home")).toEqual([])
	})
})

describe("pdfToolGroupLabelKey", () => {
	it("names a known group by its own key and any other after its first tool", () => {
		const [form] = pdfToolGroups(TOOLS, "fillSign")
		const [ocr] = pdfToolGroups(TOOLS, "tools")

		expect(form === undefined ? null : pdfToolGroupLabelKey(form)).toBe("previewPdfRibbonGroupForm")
		expect(ocr === undefined ? null : pdfToolGroupLabelKey(ocr)).toBe("previewPdfSaveAsCopy")
		expect(pdfToolGroupLabelKey({ id: "empty", tools: [] })).toBeNull()
	})
})

describe("pdfToolControl", () => {
	const [draw, reset] = TOOLS

	it("presses a mode tool while it is active and never an action tool", () => {
		if (draw === undefined || reset === undefined) throw new Error("fixture")

		expect(pdfToolControl(draw, OPEN, "draw")).toEqual({ reasonKey: null, pressed: true })
		expect(pdfToolControl(draw, OPEN, null)).toEqual({ reasonKey: null, pressed: false })
		expect(pdfToolControl(reset, OPEN, "reset").pressed).toBeUndefined()
	})

	it("carries the reason a tool is not offered", () => {
		if (draw === undefined) throw new Error("fixture")

		expect(pdfToolControl(draw, { ...OPEN, online: false }, null).reasonKey).toBe("previewPdfToolOffline")
		expect(pdfToolControl(draw, { ...OPEN, editable: false }, null).reasonKey).toBe("previewPdfToolNotEditable")
	})

	it("toggles a mode tool off when chosen again", () => {
		if (draw === undefined) throw new Error("fixture")

		expect(nextActiveTool(draw, null)).toBe("draw")
		expect(nextActiveTool(draw, "text")).toBe("draw")
		expect(nextActiveTool(draw, "draw")).toBeNull()
	})
})

describe("pdfRibbonTab", () => {
	it("accepts the ribbon's tabs only", () => {
		expect(pdfRibbonTab("pages")).toBe("pages")
		expect(pdfRibbonTab("view")).toBeNull()
	})
})
