import { CheckIcon, CircleIcon, SignatureIcon, TypeIcon, TypeOutlineIcon, XIcon, type LucideIcon } from "lucide-react"
import type { PdfToolClass } from "@filen/office/core/pdfedit"
import type { PdfCommandName } from "@filen/office/dom/pdfedit"
import {
	FillSignInitialsPanel,
	FillSignOverlay,
	FillSignSignaturePanel,
	FillSignStartPanel
} from "@/features/pdf/fillSign/fillSignPlacement"
import type { FillSignMode } from "@/features/pdf/fillSign/fillSign.logic"
import { toolEnabled, whileActive, type PdfTool, type PdfToolOverlayProps } from "@/features/pdf/tools/registry"
import type { PreviewKey } from "@/lib/i18n"
import type { ActionDef } from "@/lib/keymap/registry"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"

// The Fill & Sign tab's placing tools: Add text, the check / cross / dot marks, and Sign (signature, initials). Each is
// a mode tool: its overlay makes every page shown a surface to place on (pointer or keyboard), its panel starts the
// editor (and, for Sign, asks for the signature first). Text and marks are annotations; a visual signature is the
// "sign" kind of change (a picture of a signature, never a certificate signature).

function fillSignTool(
	id: string,
	group: string,
	order: number,
	labelKey: PreviewKey,
	icon: LucideIcon,
	toolClass: PdfToolClass,
	command: PdfCommandName,
	mode: FillSignMode,
	Panel: NonNullable<PdfTool["Panel"]>,
	// Its letter on the page surface, if it has one.
	key?: ActionDef
): PdfTool {
	return {
		id,
		ribbon: { tab: "fillSign", group, order },
		labelKey,
		icon,
		toolClass,
		actionIds: key === undefined ? [] : [key.id],
		actions: key === undefined ? [] : [key],
		enabledWhen: policy => toolEnabled(toolClass, policy),
		commands: [command],
		Overlay: (props: PdfToolOverlayProps) => (
			<FillSignOverlay
				{...props}
				mode={mode}
			/>
		),
		// Its panel starts the editor (and Sign asks for the signature) when it mounts.
		Panel: whileActive(Panel)
	}
}

export const FILL_SIGN_TOOLS: readonly PdfTool[] = [
	fillSignTool(
		"fillSign.text",
		"fill",
		100,
		"previewPdfFillText",
		TypeIcon,
		"annotate",
		"fillSign.text",
		{ kind: "text" },
		FillSignStartPanel
	),
	fillSignTool(
		"fillSign.check",
		"fill",
		110,
		"previewPdfFillCheck",
		CheckIcon,
		"annotate",
		"fillSign.mark",
		{ kind: "mark", mark: "check" },
		FillSignStartPanel
	),
	fillSignTool(
		"fillSign.cross",
		"fill",
		120,
		"previewPdfFillCross",
		XIcon,
		"annotate",
		"fillSign.mark",
		{ kind: "mark", mark: "cross" },
		FillSignStartPanel
	),
	fillSignTool(
		"fillSign.dot",
		"fill",
		130,
		"previewPdfFillDot",
		CircleIcon,
		"annotate",
		"fillSign.mark",
		{ kind: "mark", mark: "dot" },
		FillSignStartPanel
	),
	fillSignTool(
		"fillSign.signature",
		"sign",
		200,
		"previewPdfFillSignature",
		SignatureIcon,
		"sign",
		"fillSign.signature",
		{ kind: "signature", role: "signature" },
		FillSignSignaturePanel,
		pdfToolAction("pdf.tool.sign", "s", "preview:previewPdfKeyToolSign")
	),
	fillSignTool(
		"fillSign.initials",
		"sign",
		210,
		"previewPdfFillInitials",
		TypeOutlineIcon,
		"sign",
		"fillSign.signature",
		{ kind: "signature", role: "initials" },
		FillSignInitialsPanel
	)
]
