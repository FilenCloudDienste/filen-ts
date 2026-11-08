// "preview" namespace, Word document editor — the editor's font, size, colour and paragraph controls. Spread into preview.ts; same catalog rules.
export const previewDocxFormat = {
	/** Docx editor — toolbar toggle/menu item: raises the selected text as superscript */
	previewDocxSuperscript: "Superscript",
	/** Docx editor — toolbar toggle/menu item: lowers the selected text as subscript */
	previewDocxSubscript: "Subscript",
	/** Docx editor — formatting menu item: double strikethrough */
	previewDocxDoubleStrikethrough: "Double strikethrough",
	/** Docx editor — formatting menu item: small capitals */
	previewDocxSmallCaps: "Small caps",
	/** Docx editor — formatting menu item: all capitals */
	previewDocxAllCaps: "All caps",
	/** Docx editor — formatting command: double underline */
	previewDocxDoubleUnderline: "Double underline",
	/** Docx editor — formatting command: cycles the selected text through lower case, title case and upper case */
	previewDocxChangeCase: "Change case",
	/** Docx editor — formatting menu item: removes all formatting and resets the paragraphs to the Normal style */
	previewDocxClearAllFormatting: "Clear all formatting",
	/** Docx editor — font picker label */
	previewDocxFont: "Font",
	/** Docx editor — font size picker label */
	previewDocxFontSize: "Font size",
	/** Docx editor — toolbar button: one font size larger */
	previewDocxFontGrow: "Increase font size",
	/** Docx editor — toolbar button: one font size smaller */
	previewDocxFontShrink: "Decrease font size",
	/** Docx editor — formatting command: font size one point larger */
	previewDocxFontGrowPoint: "Increase font size by 1 point",
	/** Docx editor — formatting command: font size one point smaller */
	previewDocxFontShrinkPoint: "Decrease font size by 1 point",
	/** Docx editor — formatting submenu: spacing between characters */
	previewDocxCharacterSpacing: "Character spacing",
	/** Docx editor — character spacing step: condensed by 3 points */
	previewDocxSpacingVeryTight: "Very tight",
	/** Docx editor — character spacing step: condensed by 1.5 points */
	previewDocxSpacingTight: "Tight",
	/** Docx editor — character spacing step: normal */
	previewDocxSpacingNormal: "Normal",
	/** Docx editor — character spacing step: expanded by 1.5 points */
	previewDocxSpacingLoose: "Loose",
	/** Docx editor — character spacing step: expanded by 3 points */
	previewDocxSpacingVeryLoose: "Very loose",
	/** Docx editor — toolbar button: text colour picker */
	previewDocxFontColor: "Font color",
	/** Docx editor — toolbar button: highlighter colour picker */
	previewDocxHighlightColor: "Highlight color",
	/** Docx editor — ⋯ submenu: line spacing */
	previewDocxLineSpacing: "Line spacing",
	/** Docx editor — line spacing option; {{value}} is the multiple, e.g. 1.15 */
	previewDocxLineSpacingValue: "{{value, number}}",
	/** Docx editor — label of the space before/after paragraph command */
	previewDocxParagraphSpacing: "Paragraph spacing",
	/** Docx editor — label of the paragraph indent command */
	previewDocxIndents: "Indents",
	/** Docx editor — toolbar button: format painter (click copies the formatting for the next selection, double click keeps it on) */
	previewDocxFormatPainter: "Format painter",
	/** Docx editor — label of applying the format painter's formatting */
	previewDocxPasteFormatting: "Paste formatting",
	/** Docx editor — format painter tooltip while it is on for every selection until clicked again */
	previewDocxFormatPainterSticky: "Format painter (on until clicked again)",
	/** Docx editor — toolbar menu holding the other character formatting (sub/superscript, caps, spacing) */
	previewDocxMoreFormatting: "More formatting",
	/** Docx editor — font picker group: the theme's fonts */
	previewDocxFontsTheme: "Theme fonts",
	/** Docx editor — font picker group: fonts the document uses */
	previewDocxFontsDocument: "In this document",
	/** Docx editor — font picker group: common fonts */
	previewDocxFontsCommon: "Common fonts",
	/** Docx editor — the theme's heading font in the font picker; {{name}} is the font */
	previewDocxFontHeadings: "{{name}} (Headings)",
	/** Docx editor — the theme's body font in the font picker; {{name}} is the font */
	previewDocxFontBody: "{{name}} (Body)",
	/** Docx editor — font or size picker value while the selection has several */
	previewDocxValueMixed: "Several",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightYellow: "Yellow",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightGreen: "Bright green",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightCyan: "Turquoise",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightMagenta: "Pink",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightBlue: "Blue",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightRed: "Red",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkBlue: "Dark blue",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkCyan: "Teal",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkGreen: "Green",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkMagenta: "Violet",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkRed: "Dark red",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkYellow: "Dark yellow",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightDarkGray: "Gray 50%",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightLightGray: "Gray 25%",
	/** Docx editor — highlighter colour name */
	previewDocxHighlightBlack: "Black",
	/** Docx editor — ⋯ menu item opening the Paragraph dialog (indents and spacing) */
	previewDocxParagraphAction: "Paragraph…",
	/** Docx editor — Paragraph dialog title */
	previewDocxParagraphTitle: "Paragraph",
	/** Docx editor — Paragraph dialog description */
	previewDocxParagraphBody: "Indents and spacing of the selected paragraphs. Fields left as they are don't change.",
	/** Docx editor — Paragraph dialog field: indent before the text (left in left-to-right text); {{unit}} is in or cm */
	previewDocxIndentStart: "Indent before text ({{unit}})",
	/** Docx editor — Paragraph dialog field: indent after the text; {{unit}} is in or cm */
	previewDocxIndentEnd: "Indent after text ({{unit}})",
	/** Docx editor — Paragraph dialog field: first line / hanging indent */
	previewDocxIndentSpecial: "Special indent",
	/** Docx editor — special indent option */
	previewDocxIndentNone: "None",
	/** Docx editor — special indent option */
	previewDocxIndentFirstLine: "First line",
	/** Docx editor — special indent option */
	previewDocxIndentHanging: "Hanging",
	/** Docx editor — Paragraph dialog field: by how much the special indent goes; {{unit}} is in or cm */
	previewDocxIndentBy: "By ({{unit}})",
	/** Docx editor — Paragraph dialog field: space before the paragraph, points */
	previewDocxSpaceBefore: "Space before (pt)",
	/** Docx editor — Paragraph dialog field: space after the paragraph, points */
	previewDocxSpaceAfter: "Space after (pt)",
	/** Docx editor — Paragraph dialog field: line spacing rule */
	previewDocxLineSpacingRule: "Line spacing",
	/** Docx editor — line spacing rule: a multiple of a line */
	previewDocxLineSpacingMultiple: "Multiple",
	/** Docx editor — line spacing rule: at least this many points */
	previewDocxLineSpacingAtLeast: "At least",
	/** Docx editor — line spacing rule: exactly this many points */
	previewDocxLineSpacingExact: "Exactly",
	/** Docx editor — Paragraph dialog field: the line spacing value (lines for a multiple, else points) */
	previewDocxLineSpacingAt: "At",
	/** Docx editor — Paragraph dialog error: a field holds no valid number */
	previewDocxInvalidNumber: "Some values aren't valid numbers."
} as const
