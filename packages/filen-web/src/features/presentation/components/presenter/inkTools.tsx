import type { ReactNode } from "react"
import { CircleDotIcon, EraserIcon, HighlighterIcon, MousePointer2Icon, PenLineIcon } from "lucide-react"
import type { InkTool } from "@filen/office/react/presentation"
import type { PreviewKey } from "@/lib/i18n"

// The presenter's pointer and ink tools and the pen's colour names, as the ink toolbar and the show menu list them.

export const INK_TOOLS: readonly { readonly tool: InkTool; readonly label: PreviewKey; readonly icon: ReactNode }[] = [
	{ tool: "none", label: "previewPptxInkArrow", icon: <MousePointer2Icon /> },
	{ tool: "pen", label: "previewPptxInkPen", icon: <PenLineIcon /> },
	{ tool: "highlighter", label: "previewPptxInkHighlighter", icon: <HighlighterIcon /> },
	{ tool: "laser", label: "previewPptxInkLaser", icon: <CircleDotIcon /> },
	{ tool: "eraser", label: "previewPptxInkEraser", icon: <EraserIcon /> }
]

export const INK_COLOR_LABELS: Readonly<Record<string, PreviewKey>> = {
	FF0000: "previewPptxInkColorRed",
	"0070C0": "previewPptxInkColorBlue",
	"00B050": "previewPptxInkColorGreen",
	FFFF00: "previewPptxInkColorYellow",
	"000000": "previewPptxInkColorBlack",
	FFFFFF: "previewPptxInkColorWhite"
}
