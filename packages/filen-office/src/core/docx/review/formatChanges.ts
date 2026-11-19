import type { Node } from "prosemirror-model"
import type { DocxEditContext } from "../edit/context"
import { runPropsOf } from "../edit/formatting"
import { docxSchema } from "../edit/schema"
import type { StoryPart } from "../model/index"
import type {
	BorderProps,
	ColorProps,
	ParagraphBordersProps,
	ParagraphProps,
	ResolvedParagraphProps,
	RunProps,
	ShadingProps,
	ThemeFontRef
} from "../props/index"
import { mergeRun } from "../styles/index"
import type { Mutable } from "../styles/merge"
import type { StyleDef } from "../styles/styles"
import { paragraphAttrs, paragraphChange, type ParagraphAttrs } from "./track"

// What a tracked formatting change changed, as Word describes it in a balloon ("Formatted: Font: Bold, Italic";
// Revision.FormatDescription): the properties whose value differs before and after (direct formatting over
// what the paragraph's style gives), each with its value after, in the order of Word's format descriptions
// (Style.Description's grammar: "Font: Arial, 12 pt, Bold, Italic, Space Before 12 pt After 3 pt,
// KeepWithNext, Level 2"). A change that leaves every value as it was is described by the formatting it has.
// The app words and localises the items.

export type EditFormatColor =
	| { readonly kind: "auto" }
	| { readonly kind: "rgb"; readonly rgb: string }
	| { readonly kind: "theme"; readonly theme: string; readonly tint?: number; readonly shade?: number }

export type EditFormatToggle = "bold" | "italic" | "strike" | "doubleStrike" | "smallCaps" | "caps" | "hidden"

// Which characters a font or size is for: Word's "(Default)" (Latin), "(Asian)" and "(Complex)" slots.
export type EditFormatScript = "default" | "asian" | "complex"

export type EditFormatItem =
	// A character or paragraph style applied (null: none, Default Paragraph Font or Normal).
	| { readonly kind: "style"; readonly paragraph: boolean; readonly name: string | null }
	// A slot's font: a typeface, or a theme font ("+Body"/"+Headings") with the typeface it stands for.
	| {
			readonly kind: "font"
			readonly script: EditFormatScript
			readonly name: string | null
			readonly theme: "body" | "headings" | null
	  }
	| { readonly kind: "size"; readonly script: "default" | "complex"; readonly points: number }
	| { readonly kind: "toggle"; readonly property: EditFormatToggle; readonly on: boolean }
	// ST_Underline style, or null for none.
	| { readonly kind: "underline"; readonly style: string | null }
	| { readonly kind: "position"; readonly value: "superscript" | "subscript" | "baseline" }
	// Character spacing, points (negative condenses; 0 normal).
	| { readonly kind: "characterSpacing"; readonly points: number }
	| { readonly kind: "color"; readonly color: EditFormatColor }
	| { readonly kind: "underlineColor"; readonly color: EditFormatColor }
	| { readonly kind: "highlight"; readonly on: boolean }
	// Shading fill (null: none).
	| { readonly kind: "shading"; readonly color: EditFormatColor | null }
	| { readonly kind: "align"; readonly value: "left" | "center" | "right" | "justify" | "distribute" }
	// Twips.
	| { readonly kind: "indent"; readonly side: "left" | "right" | "firstLine" | "hanging"; readonly twips: number }
	// "auto": 240ths of a line; "exact" / "atLeast": twips.
	| { readonly kind: "lineSpacing"; readonly rule: "auto" | "exact" | "atLeast"; readonly value: number }
	// Points, or "auto" (w:beforeAutospacing / w:afterAutospacing).
	| { readonly kind: "space"; readonly side: "before" | "after"; readonly points: number | "auto" }
	// The paragraph's list: its kind and level (1-based), or none.
	| { readonly kind: "list"; readonly list: "bullet" | "numbered" | "none"; readonly level: number }
	| { readonly kind: "borders" }
	| { readonly kind: "keepNext" | "keepLines" | "pageBreakBefore"; readonly on: boolean }
	// 1..9, or null for body text.
	| { readonly kind: "outlineLevel"; readonly level: number | null }

type ToggleKey = "bold" | "italic" | "strike" | "doubleStrike" | "smallCaps" | "caps" | "vanish"

const TOGGLES: readonly (readonly [EditFormatToggle, ToggleKey])[] = [
	["bold", "bold"],
	["italic", "italic"],
	["strike", "strike"],
	["doubleStrike", "doubleStrike"],
	["smallCaps", "smallCaps"],
	["caps", "caps"],
	["hidden", "vanish"]
]

// Word's size and font without document defaults (10 pt Times New Roman), in half-points.
const DEFAULT_SIZE = 20
const DEFAULT_FONT = "Times New Roman"

function colorKey(color: ColorProps | undefined): string {
	const theme = color?.themeColor

	if (theme !== undefined && theme !== "none")
		return `theme:${theme}:${String(color?.themeTint ?? "")}:${String(color?.themeShade ?? "")}`

	const value = color?.val?.toUpperCase()

	return value === undefined || value === "AUTO" ? "auto" : value
}

function colorOf(color: ColorProps | undefined): EditFormatColor {
	const theme = color?.themeColor

	if (theme !== undefined && theme !== "none") {
		return {
			kind: "theme",
			theme,
			...(color?.themeTint === undefined ? {} : { tint: color.themeTint }),
			...(color?.themeShade === undefined ? {} : { shade: color.themeShade })
		}
	}

	const value = color?.val

	return value === undefined || value.toLowerCase() === "auto" ? { kind: "auto" } : { kind: "rgb", rgb: value.toUpperCase() }
}

function shadingKey(shading: ShadingProps | undefined): string {
	return shading === undefined ? "" : `${shading.pattern}|${colorKey(shading.fill)}|${colorKey(shading.color)}`
}

function borderKey(border: BorderProps | undefined): string {
	return border === undefined ? "" : `${border.style}|${String(border.size ?? "")}|${String(border.space ?? "")}|${colorKey(border)}`
}

function bordersKey(borders: ParagraphBordersProps | undefined): string {
	return borders === undefined
		? ""
		: [borders.top, borders.start, borders.bottom, borders.end, borders.between, borders.bar].map(borderKey).join("/")
}

function styleName(context: DocxEditContext, id: string | undefined): string | null {
	if (id === undefined) return null

	return context.styles.byId(id)?.name ?? context.newStyles.get(id) ?? id
}

// One properties object per paragraph style (and none), the key the resolver keeps a style's formatting under.
const STYLE_ONLY = new WeakMap<DocxEditContext, Map<string, ParagraphProps>>()

function styleOnly(context: DocxEditContext, styleId: string | undefined): ParagraphProps {
	let byStyle = STYLE_ONLY.get(context)

	if (byStyle === undefined) {
		byStyle = new Map()
		STYLE_ONLY.set(context, byStyle)
	}

	const key = styleId ?? ""
	let props = byStyle.get(key)

	if (props === undefined) {
		props = styleId === undefined ? {} : { styleId }
		byStyle.set(key, props)
	}

	return props
}

// A character style's run properties along its basedOn chain.
function characterRun(context: DocxEditContext, styleId: string): RunProps {
	const acc: Mutable<RunProps> = {}
	const chain: StyleDef[] = []

	for (
		let style = context.resolver.characterStyle(styleId);
		style !== undefined && chain.length < 32;
		style = context.styles.parent(style)
	) {
		if (chain.includes(style)) break

		chain.push(style)
	}

	for (const style of chain.reverse()) mergeRun(acc, style.run)

	return acc
}

const INHERITED = new WeakMap<DocxEditContext, Map<string, RunProps>>()

// What a run in style `characterStyle` of a paragraph in style `paragraphStyle` has before its own formatting:
// the document defaults and the paragraph style, then the character style (its toggles flip theirs, §17.7.3).
function inheritedRun(context: DocxEditContext, paragraphStyle: string | undefined, characterStyle: string | undefined): RunProps {
	let byKey = INHERITED.get(context)

	if (byKey === undefined) {
		byKey = new Map()
		INHERITED.set(context, byKey)
	}

	const key = `${paragraphStyle ?? ""}\u0000${characterStyle ?? ""}`
	let run = byKey.get(key)

	if (run === undefined) {
		const base = context.resolver.paragraph(styleOnly(context, paragraphStyle)).runBase

		if (characterStyle === undefined) {
			run = base
		} else {
			const acc: Mutable<RunProps> = { ...base }

			mergeRun(acc, characterRun(context, characterStyle), context.styles.defaultRun)
			run = acc
		}

		byKey.set(key, run)
	}

	return run
}

function inheritedParagraph(context: DocxEditContext, styleId: string | undefined): ResolvedParagraphProps {
	return context.resolver.paragraph(styleOnly(context, styleId)).props
}

type FontSlot = readonly [name: string | undefined, theme: ThemeFontRef | undefined]

function fontSlot(props: RunProps, script: EditFormatScript): FontSlot | undefined {
	const fonts = props.fonts

	if (fonts === undefined) return undefined

	const slot: FontSlot =
		script === "asian"
			? [fonts.eastAsia, fonts.eastAsiaTheme]
			: script === "complex"
				? [fonts.cs, fonts.csTheme]
				: [fonts.ascii ?? fonts.hAnsi, fonts.asciiTheme ?? fonts.hAnsiTheme]

	return slot[0] === undefined && slot[1] === undefined ? undefined : slot
}

function fontItem(context: DocxEditContext, script: EditFormatScript, slot: FontSlot | undefined): EditFormatItem {
	const theme = slot?.[1]

	if (theme !== undefined) {
		return {
			kind: "font",
			script,
			name: context.resolver.theme?.font(theme) ?? null,
			theme: theme.startsWith("major") ? "headings" : "body"
		}
	}

	return { kind: "font", script, name: slot?.[0] ?? null, theme: null }
}

function highlighted(value: string | undefined): string | null {
	return value === undefined || value === "none" ? null : value
}

// What changed in a run's formatting (in a paragraph of style `paragraphStyle`): the font, then its colour,
// highlight and shading. Values the run does not set are the style's.
export function runFormatChanges(
	context: DocxEditContext,
	before: RunProps,
	after: RunProps,
	paragraphStyle: string | undefined
): EditFormatItem[] {
	const inheritedBefore = inheritedRun(context, paragraphStyle, before.styleId)
	const inheritedAfter = inheritedRun(context, paragraphStyle, after.styleId)
	const out: EditFormatItem[] = []
	const of = <K extends keyof RunProps>(props: RunProps, key: K): RunProps[K] =>
		props[key] ?? (props === before ? inheritedBefore : inheritedAfter)[key]
	const toggles = (list: readonly (readonly [EditFormatToggle, ToggleKey])[]): void => {
		for (const [property, key] of list) {
			const on = of(after, key) === true

			if ((of(before, key) === true) !== on) out.push({ kind: "toggle", property, on })
		}
	}

	if (before.styleId !== after.styleId) out.push({ kind: "style", paragraph: false, name: styleName(context, after.styleId) })

	// As Word lists them: the Asian font first.
	for (const script of ["asian", "default", "complex"] as const) {
		const was = fontSlot(before, script) ?? fontSlot(inheritedBefore, script)
		const now = fontSlot(after, script) ?? fontSlot(inheritedAfter, script)

		if (was?.[0] !== now?.[0] || was?.[1] !== now?.[1]) out.push(fontItem(context, script, now))
	}

	const size = of(after, "size") ?? DEFAULT_SIZE
	const sizeCs = of(after, "sizeCs") ?? size

	const sizeChanged = (of(before, "size") ?? DEFAULT_SIZE) !== size

	if (sizeChanged) out.push({ kind: "size", script: "default", points: size / 2 })

	// The complex scripts' size apart only where it is not the size given with it.
	if ((of(before, "sizeCs") ?? of(before, "size") ?? DEFAULT_SIZE) !== sizeCs && (!sizeChanged || sizeCs !== size))
		out.push({ kind: "size", script: "complex", points: sizeCs / 2 })

	toggles(TOGGLES.slice(0, 2))

	const underline = of(after, "underline")
	const style = underline === undefined || underline.style === "none" ? null : underline.style
	const wasUnderline = of(before, "underline")

	if ((wasUnderline === undefined || wasUnderline.style === "none" ? null : wasUnderline.style) !== style)
		out.push({ kind: "underline", style })

	toggles(TOGGLES.slice(2))

	const position = of(after, "vertAlign") ?? "baseline"

	if ((of(before, "vertAlign") ?? "baseline") !== position) out.push({ kind: "position", value: position })

	const spacing = of(after, "spacing") ?? 0

	if ((of(before, "spacing") ?? 0) !== spacing) out.push({ kind: "characterSpacing", points: spacing / 20 })
	if (colorKey(of(before, "color")) !== colorKey(of(after, "color"))) out.push({ kind: "color", color: colorOf(of(after, "color")) })
	if (style !== null && colorKey(wasUnderline) !== colorKey(underline)) out.push({ kind: "underlineColor", color: colorOf(underline) })

	const highlight = highlighted(of(after, "highlight"))

	if (highlighted(of(before, "highlight")) !== highlight) out.push({ kind: "highlight", on: highlight !== null })

	const shading = of(after, "shading")

	if (shadingKey(of(before, "shading")) !== shadingKey(shading)) {
		const fill = colorOf(shading?.fill)

		out.push({ kind: "shading", color: shading === undefined || fill.kind === "auto" ? null : fill })
	}

	return out
}

// The paragraph properties the descriptions compare.
export type ParagraphFormat = Pick<
	ParagraphProps,
	"styleId" | "alignment" | "indent" | "spacing" | "numbering" | "borders" | "keepNext" | "keepLines" | "pageBreakBefore" | "outlineLevel"
>

const ALIGNMENTS: Readonly<Record<string, "left" | "center" | "right" | "justify" | "distribute">> = {
	start: "left",
	left: "left",
	center: "center",
	end: "right",
	right: "right",
	both: "justify",
	distribute: "distribute",
	thaiDistribute: "distribute",
	lowKashida: "justify",
	mediumKashida: "justify",
	highKashida: "justify"
}

function listKind(context: DocxEditContext, numId: number, level: number): "bullet" | "numbered" {
	if (numId < 0) return context.newLists.get(numId)?.kind ?? "numbered"

	return context.numbering?.level(numId, level)?.level.format === "bullet" ? "bullet" : "numbered"
}

// A paragraph's effective values: its own where set, else its style's.
interface Effective {
	readonly alignment: string
	readonly start: number
	readonly end: number
	// Signed: negative for a hanging indent.
	readonly firstLine: number
	readonly before: number
	readonly beforeAuto: boolean
	readonly after: number
	readonly afterAuto: boolean
	readonly line: number
	readonly lineRule: "auto" | "exact" | "atLeast"
	readonly keepNext: boolean
	readonly keepLines: boolean
	readonly pageBreakBefore: boolean
	readonly outlineLevel: number | undefined
}

function effective(context: DocxEditContext, props: ParagraphFormat): Effective {
	const style = inheritedParagraph(context, props.styleId)
	const indent = props.indent
	const spacing = props.spacing
	const hanging = indent?.hanging
	const firstLine =
		hanging !== undefined && hanging > 0
			? -hanging
			: indent?.firstLine !== undefined
				? indent.firstLine
				: hanging !== undefined
					? -hanging
					: style.indent.firstLine

	return {
		alignment: props.alignment ?? style.alignment,
		start: indent?.start ?? style.indent.start,
		end: indent?.end ?? style.indent.end,
		firstLine,
		before: spacing?.before ?? style.spacing.before,
		beforeAuto: spacing?.beforeAutospacing ?? style.spacing.beforeAutospacing,
		after: spacing?.after ?? style.spacing.after,
		afterAuto: spacing?.afterAutospacing ?? style.spacing.afterAutospacing,
		line: spacing?.line ?? style.spacing.line,
		lineRule: spacing?.lineRule ?? style.spacing.lineRule,
		keepNext: props.keepNext ?? style.keepNext,
		keepLines: props.keepLines ?? style.keepLines,
		pageBreakBefore: props.pageBreakBefore ?? style.pageBreakBefore,
		outlineLevel: props.outlineLevel ?? style.outlineLevel
	}
}

// What changed in a paragraph's formatting: its style, alignment, indents, line spacing, space before and after,
// list, borders, then how it breaks across pages and its outline level. Values the paragraph does not set are
// its style's.
export function paragraphFormatChanges(context: DocxEditContext, before: ParagraphFormat, after: ParagraphFormat): EditFormatItem[] {
	const out: EditFormatItem[] = []
	const was = effective(context, before)
	const now = effective(context, after)
	const align = ALIGNMENTS[now.alignment] ?? "left"

	if (before.styleId !== after.styleId) out.push({ kind: "style", paragraph: true, name: styleName(context, after.styleId) })
	if ((ALIGNMENTS[was.alignment] ?? "left") !== align) out.push({ kind: "align", value: align })
	if (was.start !== now.start) out.push({ kind: "indent", side: "left", twips: now.start })
	if (was.end !== now.end) out.push({ kind: "indent", side: "right", twips: now.end })

	if (was.firstLine !== now.firstLine) {
		out.push(
			now.firstLine < 0
				? { kind: "indent", side: "hanging", twips: -now.firstLine }
				: { kind: "indent", side: "firstLine", twips: now.firstLine }
		)
	}

	if (was.line !== now.line || was.lineRule !== now.lineRule) out.push({ kind: "lineSpacing", rule: now.lineRule, value: now.line })
	if (was.before !== now.before || was.beforeAuto !== now.beforeAuto)
		out.push({ kind: "space", side: "before", points: now.beforeAuto ? "auto" : now.before / 20 })
	if (was.after !== now.after || was.afterAuto !== now.afterAuto)
		out.push({ kind: "space", side: "after", points: now.afterAuto ? "auto" : now.after / 20 })

	if (
		(before.numbering?.numId ?? 0) !== (after.numbering?.numId ?? 0) ||
		(before.numbering?.ilvl ?? 0) !== (after.numbering?.ilvl ?? 0)
	) {
		const numId = after.numbering?.numId ?? 0
		const level = after.numbering?.ilvl ?? 0

		out.push(
			numId === 0
				? { kind: "list", list: "none", level: 1 }
				: { kind: "list", list: listKind(context, numId, level), level: level + 1 }
		)
	}

	if (bordersKey(before.borders) !== bordersKey(after.borders)) out.push({ kind: "borders" })

	for (const kind of ["keepNext", "keepLines", "pageBreakBefore"] as const) if (was[kind] !== now[kind]) out.push({ kind, on: now[kind] })

	if (was.outlineLevel !== now.outlineLevel) {
		const level = now.outlineLevel

		out.push({ kind: "outlineLevel", level: level === undefined || level >= 9 ? null : level + 1 })
	}

	return out
}

// A paragraph's editing attributes (complete: the source's values unless a command changed them) as the
// properties the descriptions compare.
export function paragraphFormatOf(attrs: ParagraphAttrs): ParagraphFormat {
	return {
		...(attrs.styleId === null ? {} : { styleId: attrs.styleId }),
		...(attrs.align === null ? {} : { alignment: attrs.align }),
		...(attrs.indent === null ? {} : { indent: attrs.indent }),
		...(attrs.spacing === null ? {} : { spacing: attrs.spacing }),
		...(attrs.numId === null ? {} : { numbering: { numId: attrs.numId, ...(attrs.ilvl === null ? {} : { ilvl: attrs.ilvl }) } }),
		...(attrs.borders === null ? {} : { borders: attrs.borders })
	}
}

const EMPTY_RUN: RunProps = {}

// A change that leaves every value as it was (formatting changed and changed back) still is one: described,
// as Word does, by the formatting the text has over its style, or by the style alone.
function orHas(found: EditFormatItem[], has: () => EditFormatItem[], plain: () => EditFormatItem[]): EditFormatItem[] {
	if (found.length > 0) return found

	const own = has()

	return own.length > 0 ? own : plain()
}

// The font and size plain text of a paragraph in style `paragraphStyle` shows (its style's).
function plainRun(context: DocxEditContext, paragraphStyle: string | undefined): EditFormatItem[] {
	const inherited = inheritedRun(context, paragraphStyle, undefined)

	return [
		fontItem(context, "default", fontSlot(inherited, "default") ?? [DEFAULT_FONT, undefined]),
		{ kind: "size", script: "default", points: (inherited.size ?? DEFAULT_SIZE) / 2 }
	]
}

// What a tracked run formatting change at text node `node` (in a paragraph of style `paragraphStyle`)
// changed: against the run properties the editor recorded as before (`base`, -1 for none), or, for one read
// from the file, the w:rPrChange of its run's w:rPr.
export function textFormatChanges(context: DocxEditContext, node: Node, paragraphStyle: string | undefined): EditFormatItem[] {
	const change = docxSchema.marks.format_change.isInSet(node.marks)

	if (change === undefined) return []

	const recorded: unknown = change.attrs["base"]
	const run: unknown = docxSchema.marks.run.isInSet(node.marks)?.attrs["base"]
	const source = typeof run === "number" && run >= 0 ? context.bases.get(run)?.props : undefined
	// What no command sets (hidden text) is the run's source formatting's.
	const marked = runPropsOf(node.marks)
	const after: RunProps = source?.vanish === undefined ? marked : { ...marked, vanish: source.vanish }
	const before: RunProps =
		typeof recorded === "number"
			? recorded < 0
				? EMPTY_RUN
				: (context.bases.get(recorded)?.props ?? EMPTY_RUN)
			: (source?.change?.previous ?? EMPTY_RUN)

	return orHas(
		runFormatChanges(context, before, after, paragraphStyle),
		() => runFormatChanges(context, EMPTY_RUN, after, paragraphStyle),
		() => plainRun(context, paragraphStyle)
	)
}

function pick(props: ParagraphProps | undefined): ParagraphFormat {
	if (props === undefined) return {}

	const { styleId, alignment, indent, spacing, numbering, borders, keepNext, keepLines, pageBreakBefore, outlineLevel } = props

	return Object.fromEntries(
		Object.entries({
			styleId,
			alignment,
			indent,
			spacing,
			numbering,
			borders,
			keepNext,
			keepLines,
			pageBreakBefore,
			outlineLevel
		}).filter(([, value]) => value !== undefined)
	) as ParagraphFormat
}

// What a tracked paragraph property change of paragraph `node` changed: against the attributes the editor
// recorded as before, or, for one read from the file, its w:pPrChange (its other properties as the file has
// them, the editing attributes as they are now).
export function paragraphChangeFormat(context: DocxEditContext, part: StoryPart, node: Node): EditFormatItem[] {
	const now = paragraphFormatOf(paragraphAttrs(node))
	const recorded = paragraphChange(node)?.props
	let before: ParagraphFormat
	let after: ParagraphFormat = now

	if (recorded !== undefined) {
		before = paragraphFormatOf(recorded.before)
	} else {
		const src: unknown = node.attrs["src"]
		const row = typeof src === "number" && src >= 0 ? (part.aux[src] ?? -1) : -1
		const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)

		if (pPr < 0) return []

		const props = context.store.paragraph(part.document, pPr)
		// The editing attributes are the paragraph's now, set or not; its other properties are the file's.
		const { keepNext, keepLines, pageBreakBefore, outlineLevel } = pick(props)

		before = pick(props.change?.previous)
		after = {
			...(keepNext === undefined ? {} : { keepNext }),
			...(keepLines === undefined ? {} : { keepLines }),
			...(pageBreakBefore === undefined ? {} : { pageBreakBefore }),
			...(outlineLevel === undefined ? {} : { outlineLevel }),
			...now
		}
	}

	return orHas(
		paragraphFormatChanges(context, before, after),
		() => paragraphFormatChanges(context, after.styleId === undefined ? {} : { styleId: after.styleId }, after),
		() => [{ kind: "style", paragraph: true, name: styleName(context, after.styleId) }]
	)
}
