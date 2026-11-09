// "preview" namespace, presentation editor: editing the text of a shape, and the Home tab's Font and Paragraph
// groups. Spread into preview.ts; same catalog rules. Commands Word's ribbon names the same (bold, italic, sizes,
// colours, spacing, alignment) reuse the previewDocx keys.
export const previewPptxText = {
	/** Presentation editor — accessible name of the text box being edited on the slide */
	previewPptxTextEditorLabel: "Slide text",
	/** Presentation editor — Home tab group: font, size, bold, colours */
	previewPptxTextFontGroup: "Font",
	/** Presentation editor — Home tab group: bullets, numbering, levels, alignment, spacing */
	previewPptxTextParagraphGroup: "Paragraph",
	/** Presentation editor — font picker entry: the theme's heading font */
	previewPptxTextThemeHeadings: "Headings (theme font)",
	/** Presentation editor — font picker entry: the theme's body font */
	previewPptxTextThemeBody: "Body (theme font)",
	/** Presentation editor — font picker: the font the selection shows is not one the deck's fonts list */
	previewPptxTextFontMixed: "Several fonts",
	/** Presentation editor — menu of underline styles */
	previewPptxTextUnderlineStyle: "Underline style",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineNone: "No underline",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineSingle: "Single",
	/** Presentation editor — underline style: only the words, not the spaces between them */
	previewPptxTextUnderlineWords: "Words only",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDouble: "Double",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineHeavy: "Heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDotted: "Dotted",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDottedHeavy: "Dotted heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDash: "Dashed",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDashHeavy: "Dashed heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDashLong: "Long dashes",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDashLongHeavy: "Long dashes heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDotDash: "Dot dash",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDotDashHeavy: "Dot dash heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDotDotDash: "Dot dot dash",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineDotDotDashHeavy: "Dot dot dash heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineWavy: "Wavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineWavyHeavy: "Wavy heavy",
	/** Presentation editor — underline style */
	previewPptxTextUnderlineWavyDouble: "Double wavy",
	/** Presentation editor — menu of more text formats: strikethrough kinds, case, character spacing */
	previewPptxTextMoreFormats: "More text formats",
	/** Presentation editor — menu section and command: how letters are cased */
	previewPptxTextCase: "Change case",
	/** Presentation editor — letter case: as typed */
	previewPptxTextCaseNone: "As typed",
	/** Presentation editor — menu section: space between letters */
	previewPptxTextCharacterSpacing: "Character spacing",
	/** Presentation editor — bullets gallery: no bullet */
	previewPptxTextBulletNone: "None",
	/** Presentation editor — bullets gallery entry */
	previewPptxTextBulletFilledRound: "Filled round bullets",
	/** Presentation editor — bullets gallery entry */
	previewPptxTextBulletHollowRound: "Hollow round bullets",
	/** Presentation editor — bullets gallery entry */
	previewPptxTextBulletFilledSquare: "Filled square bullets",
	/** Presentation editor — bullets gallery entry */
	previewPptxTextBulletCheck: "Check mark bullets",
	/** Presentation editor — bullets gallery entry */
	previewPptxTextBulletArrow: "Arrow bullets",
	/** Presentation editor — numbering gallery entry, e.g. "1. 2. 3." */
	previewPptxTextNumberArabicPeriod: "1. 2. 3.",
	/** Presentation editor — numbering gallery entry */
	previewPptxTextNumberArabicParenR: "1) 2) 3)",
	/** Presentation editor — numbering gallery entry */
	previewPptxTextNumberRomanUcPeriod: "I. II. III.",
	/** Presentation editor — numbering gallery entry */
	previewPptxTextNumberRomanLcPeriod: "i. ii. iii.",
	/** Presentation editor — numbering gallery entry */
	previewPptxTextNumberAlphaUcPeriod: "A. B. C.",
	/** Presentation editor — numbering gallery entry */
	previewPptxTextNumberAlphaLcParenR: "a) b) c)",
	/** Presentation editor — numbering gallery entry */
	previewPptxTextNumberAlphaLcPeriod: "a. b. c.",
	/** Presentation editor — numbering gallery: no numbering */
	previewPptxTextNumberNone: "None",
	/** Presentation editor — button: moves the paragraph one list level up */
	previewPptxTextLevelDecrease: "Decrease list level",
	/** Presentation editor — button: moves the paragraph one list level down */
	previewPptxTextLevelIncrease: "Increase list level",
	/** Presentation editor — alignment: spreads the letters over the whole line */
	previewPptxTextAlignDistributed: "Distributed",
	/** Presentation editor — menu: the direction text runs in the box */
	previewPptxTextDirection: "Text direction",
	/** Presentation editor — text direction */
	previewPptxTextDirectionHorizontal: "Horizontal",
	/** Presentation editor — text direction: turned a quarter clockwise */
	previewPptxTextDirectionRotate90: "Rotate all text 90°",
	/** Presentation editor — text direction: turned a quarter anticlockwise */
	previewPptxTextDirectionRotate270: "Rotate all text 270°",
	/** Presentation editor — text direction: letters stacked top to bottom */
	previewPptxTextDirectionStacked: "Stacked",
	/** Presentation editor — menu: where the text sits in its box, top to bottom */
	previewPptxTextAnchor: "Align text",
	/** Presentation editor — text placement in its box */
	previewPptxTextAnchorTop: "Top",
	/** Presentation editor — text placement in its box */
	previewPptxTextAnchorMiddle: "Middle",
	/** Presentation editor — text placement in its box */
	previewPptxTextAnchorBottom: "Bottom",
	/** Presentation editor — menu: how many columns the text box has */
	previewPptxTextColumns: "Columns",
	/** Presentation editor — number of text columns, e.g. "2 columns" */
	previewPptxTextColumnsCount_one: "{{count}} column",
	/** Presentation editor — number of text columns, e.g. "2 columns" */
	previewPptxTextColumnsCount_other: "{{count}} columns",
	/** Presentation editor — toggle: the paragraph runs right to left */
	previewPptxTextRightToLeft: "Right-to-left text",
	/** Presentation editor — button and dialog: a link on the selected text */
	previewPptxTextLink: "Link",
	/** Presentation editor — link dialog description */
	previewPptxTextLinkDescription: "Link the selected text to a web address or to a slide in this presentation.",
	/** Presentation editor — link dialog: what the link goes to */
	previewPptxTextLinkKind: "Link to",
	/** Presentation editor — link dialog choice */
	previewPptxTextLinkWeb: "Web or email address",
	/** Presentation editor — link dialog choice */
	previewPptxTextLinkSlide: "Slide in this presentation",
	/** Presentation editor — link dialog field */
	previewPptxTextLinkAddress: "Address",
	/** Presentation editor — link dialog field error */
	previewPptxTextLinkAddressInvalid: "Links can go to web (http, https) and email (mailto) addresses only.",
	/** Presentation editor — link dialog button: takes the link off the text */
	previewPptxTextLinkRemove: "Remove link",
	/** Presentation editor — link dialog button */
	previewPptxTextLinkApply: "Apply",
	/** Presentation editor — link dialog button */
	previewPptxTextLinkCancel: "Cancel",
	/** Shortcut description — presentation editor: underline the selected text */
	previewPptxShortcutUnderline: "Underline",
	/** Shortcut description — presentation editor: lowers the selected text below the line, again removes it */
	previewPptxShortcutSubscript: "Subscript",
	/** Shortcut description — presentation editor: raises the selected text above the line, again removes it */
	previewPptxShortcutSuperscript: "Superscript",
	/** Shortcut description — presentation editor: removes the selected text's character formatting */
	previewPptxShortcutClearFormatting: "Clear formatting",
	/** Shortcut description — presentation editor: the next larger font size */
	previewPptxShortcutGrowFont: "Increase font size",
	/** Shortcut description — presentation editor: the next smaller font size */
	previewPptxShortcutShrinkFont: "Decrease font size",
	/** Shortcut description — presentation editor */
	previewPptxShortcutAlignLeft: "Align text left",
	/** Shortcut description — presentation editor */
	previewPptxShortcutAlignCenter: "Center text",
	/** Shortcut description — presentation editor */
	previewPptxShortcutAlignRight: "Align text right",
	/** Shortcut description — presentation editor */
	previewPptxShortcutJustify: "Justify text",
	/** Shortcut description — presentation editor: a new line in the same paragraph */
	previewPptxShortcutLineBreak: "Line break",
	/** Shortcut description — presentation editor: one list level down (at a paragraph's start) */
	previewPptxShortcutLevelDown: "Increase list level",
	/** Shortcut description — presentation editor: one list level up */
	previewPptxShortcutLevelUp: "Decrease list level",
	/** Shortcut description — presentation editor: the paragraph one level up */
	previewPptxShortcutPromote: "Promote paragraph",
	/** Shortcut description — presentation editor: the paragraph one level down */
	previewPptxShortcutDemote: "Demote paragraph",
	/** Shortcut description — presentation editor: the selected paragraphs above the one before them */
	previewPptxShortcutMoveParagraphUp: "Move paragraphs up",
	/** Shortcut description — presentation editor: the selected paragraphs below the one after them */
	previewPptxShortcutMoveParagraphDown: "Move paragraphs down",
	/** Shortcut description — presentation editor: the next title or body placeholder, or a new slide after the last */
	previewPptxShortcutNextPlaceholder: "Next placeholder"
}
