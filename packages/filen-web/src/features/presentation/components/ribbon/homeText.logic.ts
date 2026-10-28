import type { TFunction } from "i18next"
import type { TextBodyProps } from "@filen/office/core/drawingml"
import {
	presentationHref,
	type Action,
	type Bullet,
	type DeckOp,
	type ParaProps,
	type RunProps,
	type TextCommand,
	type TextDefaults
} from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import type { ShapeSelection, TextEditing, TextEditorLabels } from "@filen/office/react/presentation"
import type { PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// What the Home tab's Font and Paragraph groups offer and how they reach the editor, apart from their controls
// (homeTextControls.tsx): the choices of each menu and the link the dialog's fields make.

// A button's width with its gap, a dropdown trigger's, the pickers' (ribbonFit's estimates).
export const BUTTON = 30
export const MENU = 44
export const FONT_PICKER = 132
export const SIZE_PICKER = 68
// The alignments the Paragraph group offers (left, center, right, justify, distributed).
export const ALIGN_COUNT = 5

// A picker's value while the selection holds several.
export const MIXED = "\u0000mixed"
// Layers whose shapes hold a text body the ribbon formats whole.
export const TEXT_ROLES: ReadonlySet<string> = new Set(["placeholder", "shape"])
// Line spacing multiples (a:spcPct of a single line).
export const LINE_SPACINGS: readonly number[] = [1, 1.15, 1.5, 2, 2.5, 3]

// What these groups need of the editor (the ribbon context's editor, with the session and the text store).
export interface TextRibbonEditor {
	readonly info: OpenInfo
	readonly render: SlideRender | undefined
	readonly selection: ShapeSelection
	readonly session: PresentationSessionApi
	readonly text: TextEditing
	command(op: DeckOp): Promise<CommandResult>
}

export function editorOf(context: PresentationRibbonContext): TextRibbonEditor | undefined {
	const editor = (context as { readonly editor?: Partial<TextRibbonEditor> }).editor

	return editor?.session === undefined || editor.text === undefined ? undefined : (editor as TextRibbonEditor)
}

export function presentationTextLabels(t: TFunction<"preview">): TextEditorLabels {
	return { editor: t("previewPptxTextEditorLabel") }
}

// The command target: the open body, or the text-bearing shapes selected.
export interface TextTarget {
	readonly enabled: boolean
	// `run` and `paragraph` are the open body's format; without one they are empty, which says nothing is mixed.
	readonly formatted: boolean
	readonly run: Partial<RunProps>
	readonly paragraph: Partial<ParaProps>
	readonly bodyPr: Partial<TextBodyProps>
	apply(make: (defaults: TextDefaults) => TextCommand): void
	setBodyPr(patch: Partial<TextBodyProps>): void
}

export const THEME_FONTS: readonly { readonly value: string; readonly label: PreviewKey }[] = [
	{ value: "+mj-lt", label: "previewPptxTextThemeHeadings" },
	{ value: "+mn-lt", label: "previewPptxTextThemeBody" }
]

export const UNDERLINES: readonly { readonly value: NonNullable<RunProps["u"]>; readonly label: PreviewKey }[] = [
	{ value: "none", label: "previewPptxTextUnderlineNone" },
	{ value: "sng", label: "previewPptxTextUnderlineSingle" },
	{ value: "words", label: "previewPptxTextUnderlineWords" },
	{ value: "dbl", label: "previewPptxTextUnderlineDouble" },
	{ value: "heavy", label: "previewPptxTextUnderlineHeavy" },
	{ value: "dotted", label: "previewPptxTextUnderlineDotted" },
	{ value: "dottedHeavy", label: "previewPptxTextUnderlineDottedHeavy" },
	{ value: "dash", label: "previewPptxTextUnderlineDash" },
	{ value: "dashHeavy", label: "previewPptxTextUnderlineDashHeavy" },
	{ value: "dashLong", label: "previewPptxTextUnderlineDashLong" },
	{ value: "dashLongHeavy", label: "previewPptxTextUnderlineDashLongHeavy" },
	{ value: "dotDash", label: "previewPptxTextUnderlineDotDash" },
	{ value: "dotDashHeavy", label: "previewPptxTextUnderlineDotDashHeavy" },
	{ value: "dotDotDash", label: "previewPptxTextUnderlineDotDotDash" },
	{ value: "dotDotDashHeavy", label: "previewPptxTextUnderlineDotDotDashHeavy" },
	{ value: "wavy", label: "previewPptxTextUnderlineWavy" },
	{ value: "wavyHeavy", label: "previewPptxTextUnderlineWavyHeavy" },
	{ value: "wavyDbl", label: "previewPptxTextUnderlineWavyDouble" }
]

// Character spacing: Word's steps (twips) as a:rPr@spc (hundredths of a point).
export function spcOf(twips: number): number {
	return twips * 5
}

export const CASES: readonly { readonly value: NonNullable<RunProps["cap"]>; readonly label: PreviewKey }[] = [
	{ value: "none", label: "previewPptxTextCaseNone" },
	{ value: "small", label: "previewDocxSmallCaps" },
	{ value: "all", label: "previewDocxAllCaps" }
]

// The six-digit colour of a run's solid fill or highlight, when it is one.
export function solidRgb(color: RunProps["fill"] | RunProps["highlight"]): string | undefined {
	if (color === undefined || color === "none") return undefined
	if (color.kind === "srgb") return color.rgb
	if (color.kind === "solid") return color.color.kind === "srgb" ? color.color.rgb : undefined

	return undefined
}

export const BULLETS: readonly { readonly bullet: Bullet; readonly font?: string; readonly label: PreviewKey }[] = [
	{ bullet: { kind: "char", char: "•" }, font: "Arial", label: "previewPptxTextBulletFilledRound" },
	{ bullet: { kind: "char", char: "o" }, font: "Courier New", label: "previewPptxTextBulletHollowRound" },
	{ bullet: { kind: "char", char: "▪" }, font: "Arial", label: "previewPptxTextBulletFilledSquare" },
	{ bullet: { kind: "char", char: "✓" }, font: "Segoe UI Symbol", label: "previewPptxTextBulletCheck" },
	{ bullet: { kind: "char", char: "➢" }, font: "Segoe UI Symbol", label: "previewPptxTextBulletArrow" }
]

export const NUMBERINGS: readonly { readonly scheme: string; readonly label: PreviewKey }[] = [
	{ scheme: "arabicPeriod", label: "previewPptxTextNumberArabicPeriod" },
	{ scheme: "arabicParenR", label: "previewPptxTextNumberArabicParenR" },
	{ scheme: "romanUcPeriod", label: "previewPptxTextNumberRomanUcPeriod" },
	{ scheme: "romanLcPeriod", label: "previewPptxTextNumberRomanLcPeriod" },
	{ scheme: "alphaUcPeriod", label: "previewPptxTextNumberAlphaUcPeriod" },
	{ scheme: "alphaLcPeriod", label: "previewPptxTextNumberAlphaLcPeriod" },
	{ scheme: "alphaLcParenR", label: "previewPptxTextNumberAlphaLcParenR" }
]

export const DIRECTIONS: readonly { readonly value: TextBodyProps["vertical"]; readonly label: PreviewKey }[] = [
	{ value: "horz", label: "previewPptxTextDirectionHorizontal" },
	{ value: "vert", label: "previewPptxTextDirectionRotate90" },
	{ value: "vert270", label: "previewPptxTextDirectionRotate270" },
	{ value: "wordArtVert", label: "previewPptxTextDirectionStacked" }
]

export const ANCHORS: readonly { readonly value: TextBodyProps["anchor"]; readonly label: PreviewKey }[] = [
	{ value: "t", label: "previewPptxTextAnchorTop" },
	{ value: "ctr", label: "previewPptxTextAnchorMiddle" },
	{ value: "b", label: "previewPptxTextAnchorBottom" }
]

// The link on the selected text: a web or email address (http, https, mailto) as the deck stores it (spaces
// percent-encoded; presentationHref), or a slide of the deck.
export function linkOfChoice(kind: "url" | "slide", url: string, slide: string, info: OpenInfo): Action | null {
	if (kind === "url") {
		const href = presentationHref(url)

		return href === undefined ? null : { kind: "url", href }
	}

	const ref = info.slides.find(entry => String(entry.ref) === slide)?.ref

	return ref === undefined ? null : { kind: "slide", slide: ref }
}
