// "preview" namespace, the presentation editor's Design tab: themes (the presentation's own and Filen's), their color
// variants, the slide size and slide backgrounds. Spread into preview.ts; same catalog rules.
export const previewPptxDesign = {
	/** Presentation editor — Design tab group label: the presentation's theme */
	previewPptxDesignThemesGroup: "Themes",
	/** Presentation editor — Design tab group label: the color variants of the current theme */
	previewPptxDesignVariantsGroup: "Variants",
	/** Presentation editor — Design tab group label: slide size and background */
	previewPptxDesignCustomizeGroup: "Customize",
	/** Presentation editor — Design tab button opening the theme gallery */
	previewPptxDesignThemes: "Themes",
	/** Presentation editor — theme gallery section: the themes (masters) this presentation already has */
	previewPptxDesignThisPresentation: "In this presentation",
	/** Presentation editor — theme gallery section: Filen's own themes */
	previewPptxDesignFilenThemes: "Filen themes",
	/** Presentation editor — Design tab: why Filen themes are off in an OpenDocument presentation */
	/** Presentation editor — theme gallery: a theme of the presentation without a name; {{n}} counts from 1 */
	previewPptxDesignThemeUntitled: "Theme {{n}}",
	/** Presentation editor — theme gallery: a Filen theme in one of its color variants; {{name}} is the theme, {{n}} 1 to 4 */
	previewPptxDesignThemeVariantName: "{{name}}, variant {{n}}",
	/** Presentation editor — theme gallery checkbox: apply the chosen theme only to the slides selected in the slide list */
	previewPptxDesignApplySelected: "Apply to selected slides only",
	/** Filen theme name: plain white */
	previewPptxDesignTheme_filen: "Filen",
	/** Filen theme name: slate gray with an accent bar */
	previewPptxDesignTheme_slate: "Slate",
	/** Filen theme name: blue with a band at the bottom */
	previewPptxDesignTheme_harbor: "Harbor",
	/** Filen theme name: warm, with a rule at the top */
	previewPptxDesignTheme_ember: "Ember",
	/** Filen theme name: green, with a band at the side */
	previewPptxDesignTheme_meadow: "Meadow",
	/** Filen theme name: serif headings in a frame */
	previewPptxDesignTheme_ledger: "Ledger",
	/** Filen theme name: gradient background with a corner */
	previewPptxDesignTheme_studio: "Studio",
	/** Filen theme name: typewriter headings */
	previewPptxDesignTheme_typewriter: "Typewriter",
	/** Presentation editor — Variants: one color variant of the current theme; {{n}} is 1 to 4 */
	previewPptxDesignVariant: "Variant {{n}}",
	/** Presentation editor — Variants tooltip when the current theme is not a Filen theme */
	previewPptxDesignVariantsUnavailable: "Color variants are offered for Filen themes",
	/** Presentation editor — Design tab menu: the slide size */
	previewPptxDesignSlideSize: "Slide size",
	/** Slide size: 16:9 at 13.333 × 7.5 in */
	previewPptxDesignSizeWidescreen: "Widescreen (16:9)",
	/** Slide size: 4:3 at 10 × 7.5 in */
	previewPptxDesignSizeStandard: "Standard (4:3)",
	/** Slide size: 16:10 */
	previewPptxDesignSizeWidescreen16x10: "Widescreen (16:10)",
	/** Slide size: A4 paper */
	previewPptxDesignSizeA4: "A4 paper",
	/** Slide size: US Letter paper */
	previewPptxDesignSizeLetter: "Letter paper",
	/** Slide size menu item opening the dialog for any size */
	previewPptxDesignSizeCustom: "Custom slide size…",
	/** Slide size dialog title */
	previewPptxDesignSizeTitle: "Slide size",
	/** Slide size dialog description */
	previewPptxDesignSizeBody: "The size of every slide in the presentation.",
	/** Slide size dialog: the size presets field */
	previewPptxDesignSizePreset: "Size",
	/** Slide size dialog: the preset shown when width and height match none */
	previewPptxDesignSizeCustomPreset: "Custom",
	/** Slide size dialog: width field; {{unit}} is cm or in */
	previewPptxDesignSizeWidth: "Width ({{unit}})",
	/** Slide size dialog: height field; {{unit}} is cm or in */
	previewPptxDesignSizeHeight: "Height ({{unit}})",
	/** Slide size dialog: error under the fields when a length is out of range; {{min}} and {{max}} carry their unit */
	previewPptxDesignSizeInvalid: "Width and height must be between {{min}} and {{max}}.",
	/** Slide size dialog: how the content follows the new size */
	previewPptxDesignSizeScale: "Content",
	/** Slide size dialog choice: scale the content to stay on the slide */
	previewPptxDesignSizeEnsureFit: "Ensure fit",
	/** Slide size dialog choice description */
	previewPptxDesignSizeEnsureFitBody: "Scales the content so it all stays on the slide.",
	/** Slide size dialog choice: scale the content to fill the slide */
	previewPptxDesignSizeMaximize: "Maximize",
	/** Slide size dialog choice description */
	previewPptxDesignSizeMaximizeBody: "Scales the content to fill the slide. Some of it may end up outside.",
	/** Slide size dialog choice: keep content as it is */
	previewPptxDesignSizeKeep: "Don't scale",
	/** Slide size dialog choice description */
	previewPptxDesignSizeKeepBody: "Keeps the content where it is.",
	/** Slide size dialog: a scaled size change refused because some content can't be moved or scaled */
	previewPptxDesignSizeLocked:
		"Some content in this presentation can't be moved or scaled here. Choose Don't scale to change the size and leave the content where it is.",
	/** Slide size dialog submit */
	previewPptxDesignSizeApply: "Apply",
	/** Presentation editor — Design tab button and dialog title: the background of the selected slides */
	previewPptxDesignFormatBackground: "Format background",
	/** Format background dialog description */
	previewPptxDesignBackgroundBody: "The background of the selected slides, or of every slide.",
	/** Format background: the kind of fill */
	previewPptxDesignBackgroundFill: "Fill",
	/** Format background fill kind */
	previewPptxDesignBackgroundSolid: "Solid",
	/** Format background fill kind */
	previewPptxDesignBackgroundGradient: "Gradient",
	/** Format background fill kind */
	previewPptxDesignBackgroundPicture: "Picture",
	/** Format background fill kind */
	previewPptxDesignBackgroundPattern: "Pattern",
	/** Format background: the solid fill's color */
	previewPptxDesignBackgroundColor: "Color",
	/** Format background: the system color picker beside a color's swatches */
	previewPptxDesignBackgroundMoreColors: "More colors",
	/** Format background: a color control's name with the color it holds ("Color: Accent 1") */
	previewPptxDesignBackgroundColorValue: "{{label}}: {{color}}",
	/** Format background: the gradient's first color */
	previewPptxDesignBackgroundFrom: "From",
	/** Format background: the gradient's second color */
	previewPptxDesignBackgroundTo: "To",
	/** Format background: the gradient's direction */
	previewPptxDesignBackgroundDirection: "Direction",
	/** Gradient direction */
	previewPptxDesignBackgroundDown: "Top to bottom",
	/** Gradient direction */
	previewPptxDesignBackgroundRight: "Left to right",
	/** Gradient direction */
	previewPptxDesignBackgroundDiagonal: "Diagonal",
	/** Format background: the pattern's foreground color */
	previewPptxDesignBackgroundForeground: "Foreground",
	/** Format background: the pattern's background color */
	previewPptxDesignBackgroundBack: "Background",
	/** Format background: the pattern itself */
	previewPptxDesignBackgroundPatternKind: "Pattern",
	/** Pattern name: 10 percent dots */
	previewPptxDesignPattern_pct10: "10%",
	/** Pattern name: 25 percent dots */
	previewPptxDesignPattern_pct25: "25%",
	/** Pattern name: 50 percent dots */
	previewPptxDesignPattern_pct50: "50%",
	/** Pattern name */
	previewPptxDesignPattern_ltHorz: "Horizontal lines",
	/** Pattern name */
	previewPptxDesignPattern_ltVert: "Vertical lines",
	/** Pattern name */
	previewPptxDesignPattern_ltDnDiag: "Downward diagonal",
	/** Pattern name */
	previewPptxDesignPattern_ltUpDiag: "Upward diagonal",
	/** Pattern name */
	previewPptxDesignPattern_smGrid: "Small grid",
	/** Pattern name */
	previewPptxDesignPattern_dotGrid: "Dotted grid",
	/** Pattern name */
	previewPptxDesignPattern_horzBrick: "Bricks",
	/** Pattern name */
	previewPptxDesignPattern_weave: "Weave",
	/** Pattern name */
	previewPptxDesignPattern_plaid: "Plaid",
	/** Format background: choose the picture file */
	previewPptxDesignBackgroundChoosePicture: "Choose picture…",
	/** Format background: no picture chosen yet */
	previewPptxDesignBackgroundNoPicture: "No picture chosen",
	/** Format background switch: hide the master's shapes (logos, decorations) on the slides */
	previewPptxDesignHideGraphics: "Hide background graphics",
	/** Format background button: apply to every slide */
	previewPptxDesignBackgroundApplyAll: "Apply to all",
	/** Format background button: take the selected slides back to their layout's background */
	previewPptxDesignBackgroundReset: "Reset background",
	/** Format background submit: apply to the selected slides */
	previewPptxDesignBackgroundApply: "Apply",
	/** Presentation editor — File menu: submenu creating a new blank presentation next to this one */
	previewPptxNewPresentation: "New presentation",
	/** File menu ▸ New presentation: a PowerPoint file */
	previewPptxNewPresentationPptx: "PowerPoint (.pptx)",
	/** File menu ▸ New presentation: an OpenDocument file */
	previewPptxNewPresentationOdp: "OpenDocument (.odp)",
	/** Toast after File ▸ New presentation created the file; {{name}} is its name */
	previewPptxNewPresentationCreated: "{{name}} was created in this directory.",
	/** Toast when File ▸ New presentation failed */
	previewPptxNewPresentationFailed: "The new presentation couldn't be created.",
	/** Presentation editor — prompt shown (editor only) in an empty title placeholder */
	previewPptxPromptTitle: "Click to add title",
	/** Presentation editor — prompt shown (editor only) in an empty subtitle placeholder */
	previewPptxPromptSubtitle: "Click to add subtitle",
	/** Presentation editor — prompt shown (editor only) in an empty text or content placeholder */
	previewPptxPromptText: "Click to add text",
	/** Presentation editor — prompt shown (editor only) in an empty picture placeholder */
	previewPptxPromptPicture: "Click to add picture",
	/** Presentation editor — prompt shown (editor only) in an empty chart placeholder */
	previewPptxPromptChart: "Click to add chart",
	/** Presentation editor — prompt shown (editor only) in an empty table placeholder */
	previewPptxPromptTable: "Click to add table",
	/** Presentation editor — prompt shown (editor only) in an empty SmartArt placeholder */
	previewPptxPromptSmartArt: "Click to add SmartArt graphic",
	/** Presentation editor — prompt shown (editor only) in an empty media placeholder */
	previewPptxPromptMedia: "Click to add media",
	/** Presentation editor — prompt shown (editor only) in an empty clip art placeholder */
	previewPptxPromptClipArt: "Click to add clip art"
}
