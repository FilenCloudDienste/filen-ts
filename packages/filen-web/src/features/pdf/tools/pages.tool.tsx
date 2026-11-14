import {
	CloudIcon,
	CopyIcon,
	FileOutputIcon,
	FilePlusIcon,
	HardDriveIcon,
	ImageIcon,
	LayoutGridIcon,
	RotateCcwIcon,
	RotateCwIcon,
	ScissorsIcon,
	Trash2Icon,
	type LucideIcon
} from "lucide-react"
import type { PdfCommandName } from "@filen/office/dom/pdfedit"
import {
	PdfExtractToolPanel,
	PdfInsertFromFilenToolPanel,
	PdfOrganiseToolPanel,
	PdfSplitToolPanel
} from "@/features/pdf/pages/pagesSurface"
import { pickFile } from "@/features/pdf/pages/pagesSurface.logic"
import {
	toolEnabled,
	whileActive,
	type PdfPolicyState,
	type PdfTool,
	type PdfToolContext,
	type PdfToolVerdict
} from "@/features/pdf/tools/registry"
import type { PdfPagesController } from "@/features/pdf/pages/pagesController"
import type { PreviewKey } from "@/lib/i18n"

// The Pages tab: Organise (the grid of every page), Insert (a blank page, a PDF from the drive or this device, a
// picture), the page actions (rotate, duplicate, delete) for the pages selected in the rail or the current page, and
// Extract / Split, which make new files beside the PDF. Page changes are refused on a signed or restricted PDF; new
// files can still be made of a signed one (its signatures drawn, not carried).

// Organise, Extract and Split read the pages of a signed PDF too: only the file's editability, being online and the
// author's restrictions decide.
function copiesEnabled(policy: PdfPolicyState): PdfToolVerdict {
	const verdict = toolEnabled("pages", policy)

	return !verdict.enabled && verdict.reasonKey === "previewPdfToolSigned" ? { enabled: true } : verdict
}

function action(
	id: string,
	group: string,
	order: number,
	labelKey: PreviewKey,
	icon: LucideIcon,
	commands: readonly PdfCommandName[],
	run: (pages: PdfPagesController) => void
): PdfTool {
	return {
		id,
		ribbon: { tab: "pages", group, order },
		labelKey,
		icon,
		toolClass: "pages",
		actionIds: [],
		actions: [],
		enabledWhen: policy => toolEnabled("pages", policy),
		commands,
		run: (context: PdfToolContext) => {
			if (context.pages !== undefined) run(context.pages)
		}
	}
}

const ORGANISE: PdfTool = {
	id: "pages.organise",
	ribbon: { tab: "pages", group: "pagesOrganise", order: 100 },
	labelKey: "previewPdfPagesOrganise",
	icon: LayoutGridIcon,
	toolClass: "pages",
	actionIds: [],
	actions: [],
	enabledWhen: copiesEnabled,
	commands: [
		"pages.move",
		"pages.rotate",
		"pages.delete",
		"pages.duplicate",
		"pages.insertBlank",
		"pages.insertImage",
		"pages.insertFrom"
	],
	Panel: whileActive(PdfOrganiseToolPanel),
	panelSlot: "top"
}

const INSERT_FROM_FILEN: PdfTool = {
	id: "pages.insertFromFilen",
	ribbon: { tab: "pages", group: "pagesInsert", order: 210 },
	labelKey: "previewPdfPagesInsertFromFilen",
	icon: CloudIcon,
	toolClass: "pages",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("pages", policy),
	commands: ["pages.insertFrom"],
	Panel: whileActive(PdfInsertFromFilenToolPanel)
}

const EXTRACT: PdfTool = {
	id: "pages.extract",
	ribbon: { tab: "pages", group: "pagesCopy", order: 400 },
	labelKey: "previewPdfPagesExtract",
	icon: FileOutputIcon,
	toolClass: "pages",
	actionIds: [],
	actions: [],
	enabledWhen: copiesEnabled,
	commands: ["pages.delete"],
	Panel: whileActive(PdfExtractToolPanel)
}

const SPLIT: PdfTool = {
	id: "pages.split",
	ribbon: { tab: "pages", group: "pagesCopy", order: 410 },
	labelKey: "previewPdfPagesSplit",
	icon: ScissorsIcon,
	toolClass: "pages",
	actionIds: [],
	actions: [],
	enabledWhen: copiesEnabled,
	commands: [],
	Panel: whileActive(PdfSplitToolPanel)
}

export const PAGES_TOOLS: readonly PdfTool[] = [
	ORGANISE,
	action("pages.insertBlank", "pagesInsert", 200, "previewPdfPagesInsertBlank", FilePlusIcon, ["pages.insertBlank"], pages => {
		pages.insertBlank()
	}),
	INSERT_FROM_FILEN,
	action("pages.insertFromDevice", "pagesInsert", 220, "previewPdfPagesInsertFromDevice", HardDriveIcon, ["pages.insertFrom"], pages => {
		pickFile("application/pdf,.pdf", file => {
			pages.insertPdf({ kind: "device", file })
		})
	}),
	action("pages.insertImage", "pagesInsert", 230, "previewPdfPagesInsertImage", ImageIcon, ["pages.insertImage"], pages => {
		pickFile("image/*", file => {
			pages.insertImage(file)
		})
	}),
	action("pages.rotateCcw", "pagesPage", 300, "previewPdfPagesRotateCcw", RotateCcwIcon, ["pages.rotate"], pages => {
		pages.rotate(pages.targets(), -90)
	}),
	action("pages.rotateCw", "pagesPage", 310, "previewPdfPagesRotateCw", RotateCwIcon, ["pages.rotate"], pages => {
		pages.rotate(pages.targets(), 90)
	}),
	action("pages.duplicate", "pagesPage", 320, "previewPdfPagesDuplicate", CopyIcon, ["pages.duplicate"], pages => {
		pages.duplicate(pages.targets())
	}),
	action("pages.delete", "pagesPage", 330, "previewPdfPagesDelete", Trash2Icon, ["pages.delete"], pages => {
		pages.remove(pages.targets())
	}),
	EXTRACT,
	SPLIT
]
