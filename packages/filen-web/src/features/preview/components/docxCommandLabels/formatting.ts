import type { DocxCommandLabels } from "@/features/preview/components/docxEditor.logic"

// The formatting controls (docxFormatControls.tsx) and the ⋯ menu's spacing and Paragraph dialog.
export const FORMATTING_LABELS: Required<DocxCommandLabels<"formatting">> = {
	"format.superscript": "previewDocxSuperscript",
	"format.subscript": "previewDocxSubscript",
	"format.doubleStrike": "previewDocxDoubleStrikethrough",
	"format.smallCaps": "previewDocxSmallCaps",
	"format.allCaps": "previewDocxAllCaps",
	"format.doubleUnderline": "previewDocxDoubleUnderline",
	"format.changeCase": "previewDocxChangeCase",
	"format.clearAll": "previewDocxClearAllFormatting",
	"font.family": "previewDocxFont",
	"font.size": "previewDocxFontSize",
	"font.grow": "previewDocxFontGrow",
	"font.shrink": "previewDocxFontShrink",
	"font.growPoint": "previewDocxFontGrowPoint",
	"font.shrinkPoint": "previewDocxFontShrinkPoint",
	"font.spacing": "previewDocxCharacterSpacing",
	"color.text": "previewDocxFontColor",
	"color.highlight": "previewDocxHighlightColor",
	"paragraph.lineSpacing": "previewDocxLineSpacing",
	"paragraph.spacing": "previewDocxParagraphSpacing",
	"paragraph.indent": "previewDocxIndents",
	"format.copy": "previewOfficeFormatPainter",
	"format.paste": "previewDocxPasteFormatting"
}
