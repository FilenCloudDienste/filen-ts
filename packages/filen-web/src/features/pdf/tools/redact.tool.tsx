import { SearchIcon, SquareDashedIcon, TextCursorInputIcon } from "lucide-react"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import { RedactAreaOverlay, RedactTextOverlay } from "@/features/pdf/redact/redactOverlay"
import { RedactAreaPanel, RedactFindPanel, RedactTextPanel } from "@/features/pdf/redact/redactPanel"
import { toolEnabled, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

// Protect › Redact: Area (drag or place a rectangle), Text (drag over text) and Find & redact (words, phrases, email
// addresses, phone numbers). Each marks content for redaction as undoable steps; the side panel lists the marks and
// applies them all (Apply redactions…), saving a verified, redacted file. Redaction changes the page content: not on
// a signed file, nor where the author restricted changes. R chooses the Area tool.

const COMMANDS = [
	"redact.markArea",
	"redact.markText",
	"redact.markFindings",
	"redact.removeMark",
	"redact.apply",
	"redact.scrub",
	"redact.sanitize"
] as const

const GROUP = "redact"

export const REDACT_AREA_TOOL: PdfTool = {
	id: "redact.area",
	ribbon: { tab: "protect", group: GROUP, order: 100 },
	labelKey: "previewPdfRedactArea",
	icon: SquareDashedIcon,
	toolClass: "content",
	actionIds: ["pdf.tool.redact"],
	actions: [pdfToolAction("pdf.tool.redact", "r", "preview:previewPdfKeyRedact")],
	enabledWhen: policy => toolEnabled("content", policy),
	commands: COMMANDS,
	Overlay: RedactAreaOverlay,
	Panel: whileActive(RedactAreaPanel)
}

export const REDACT_TEXT_TOOL: PdfTool = {
	id: "redact.text",
	ribbon: { tab: "protect", group: GROUP, order: 110 },
	labelKey: "previewPdfRedactText",
	icon: TextCursorInputIcon,
	toolClass: "content",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("content", policy),
	commands: COMMANDS,
	Overlay: RedactTextOverlay,
	Panel: whileActive(RedactTextPanel)
}

export const REDACT_FIND_TOOL: PdfTool = {
	id: "redact.find",
	ribbon: { tab: "protect", group: GROUP, order: 120 },
	labelKey: "previewPdfRedactFind",
	icon: SearchIcon,
	toolClass: "content",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("content", policy),
	commands: COMMANDS,
	Panel: whileActive(RedactFindPanel)
}
