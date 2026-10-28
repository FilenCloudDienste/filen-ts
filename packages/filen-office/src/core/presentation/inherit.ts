import type { TextBodyProps } from "../drawingml/index"
import { NodeKind, type XmlDocument } from "../xml/index"
import type {
	Deck,
	FontRef,
	ListStyle,
	Paragraph,
	ParaProps,
	PlaceholderType,
	RunProps,
	ShapeNode,
	ShapePropsEdit,
	ShapeStyleRefs,
	SlideNode,
	SlideRef,
	SourceRef,
	Xfrm
} from "./model"

// Placeholder and text-style inheritance (ECMA-376 Part 1 §19.3.1.36, MS-OI29500 §2.1.1127, Annex L.3.2):
//   slide → layout   by idx (§2.1.1127(b)): a written idx by idx alone; an implied one (idx 0) only within its
//                    class, since files that leave idx out collide with the layout's title. Without that, by type
//                    (title ≡ ctrTitle; body ≡ obj, subTitle and the content types), LibreOffice 7.5's measured
//                    behaviour for files that break §2.1.1127(a); with neither, the master placeholder of its type
//                    (measured over UNO on the corpus: a title on a layout without one sits at the master's title
//                    box), else the shape stands alone;
//   layout → master  by type (title/ctrTitle → title; body/subTitle/obj/chart/tbl/clipArt/dgm/media/pic → body;
//                    dt/ftr/sldNum/hdr → the same type);
//   notes → notes master by type.
// xfrm resolves whole from the nearest level that has one; geometry, fill, line and effects per property group
// (an edit's `props` first on each level, then the level's own spPr; a level's own p:style supplies fill, line and
// effects before any farther level, §2.1.1284); bodyPr attribute by attribute; text level by level and property by
// property: run → shape lstStyle → layout ph lstStyle → master ph lstStyle → master txStyles (title, body or other;
// notesStyle for all notes text, §19.3.1.28) → presentation defaultTextStyle. defPPr is ignored (§2.1.1383).
// The theme's objectDefaults are not a level for shapes read from a file: they format a shape when it is inserted
// (§20.1.4.1.27–28). MS-OI29500 §2.1.1379(b)/§2.1.1388(a) list them, but PowerPoint's own files are written
// against the ECMA defaults: oxsdk__typical (PowerPoint 12) has spDef wrap="none", writes wrap="none" on the shapes
// that do not wrap and leaves it out on boxes sized for wrapped text. A non-placeholder shape's p:style fontRef and
// the theme's fonts and colours are applied by the text adapter, after this chain.
//
// Layout and master placeholders never paint on slides; their other shapes paint only when showMasterSp on the
// slide (and, for master shapes, on the layout) allows it (inheritedShapes).

// What a resolver may read of the source: parsed parts by name (core/pptx PptxParts.document).
export interface SourceDocuments {
	document(part: string): XmlDocument | undefined
}

export type PlaceholderClass = "title" | "body" | "dt" | "ftr" | "sldNum" | "hdr" | "sldImg"

export function placeholderClass(type: PlaceholderType): PlaceholderClass {
	switch (type) {
		case "title":
		case "ctrTitle":
			return "title"
		case "dt":
		case "ftr":
		case "sldNum":
		case "hdr":
		case "sldImg":
			return type
		default:
			return "body"
	}
}

// Which text style of the master a shape's text starts from.
export type TextClass = "title" | "body" | "other"

export function textClassOf(shape: ShapeNode): TextClass {
	if (shape.ph === undefined) return "other"

	const kind = placeholderClass(shape.ph.type)

	// Date, footer, slide number and header text is "other" in PowerPoint's master text styles.
	return kind === "title" ? "title" : kind === "body" ? "body" : "other"
}

// How a placeholder found its parent: the layout's by idx or by type, the master's by type (no layout match), none.
export type PlaceholderMatch = "idx" | "type" | "master" | "none"

export interface InheritLevel {
	readonly node: SlideNode
	readonly shape: ShapeNode
}

function placeholders(node: SlideNode | undefined): ShapeNode[] {
	return node === undefined ? [] : node.shapes.filter(shape => shape.ph !== undefined)
}

function byType(candidates: readonly ShapeNode[], type: PlaceholderType): ShapeNode | undefined {
	const exact = candidates.find(shape => shape.ph?.type === type)

	if (exact !== undefined) return exact

	const wanted = placeholderClass(type)

	// Within the body class an exact type is preferred, then body, then any content placeholder.
	if (wanted === "body") {
		return (
			candidates.find(shape => shape.ph?.type === "body") ??
			candidates.find(shape => shape.ph?.type === "obj") ??
			candidates.find(shape => shape.ph !== undefined && placeholderClass(shape.ph.type) === "body")
		)
	}

	return candidates.find(shape => shape.ph !== undefined && placeholderClass(shape.ph.type) === wanted)
}

// The layout placeholder a slide placeholder inherits from, and how it was found.
export function layoutPlaceholder(layout: SlideNode | undefined, shape: ShapeNode): { shape?: ShapeNode; match: PlaceholderMatch } {
	const ph = shape.ph

	if (ph === undefined || layout === undefined) return { match: "none" }

	const candidates = placeholders(layout)
	const wanted = placeholderClass(ph.type)
	const indexed = candidates.find(
		candidate => candidate.ph?.idx === ph.idx && (ph.idxWritten === true || placeholderClass(candidate.ph.type) === wanted)
	)

	if (indexed !== undefined) return { shape: indexed, match: "idx" }

	const typed = byType(candidates, ph.type)

	return typed === undefined ? { match: "none" } : { shape: typed, match: "type" }
}

// The master placeholder a layout (or notes) placeholder inherits from, by type.
export function masterPlaceholder(master: SlideNode | undefined, shape: ShapeNode): ShapeNode | undefined {
	const ph = shape.ph

	if (ph === undefined || master === undefined) return undefined

	const candidates = placeholders(master)
	const wanted = placeholderClass(ph.type)

	if (wanted === "body") {
		return candidates.find(candidate => candidate.ph?.type === "body") ?? byType(candidates, ph.type)
	}

	return byType(candidates, ph.type)
}

function parentOf(deck: Deck, node: SlideNode): SlideNode | undefined {
	return node.parent === undefined ? undefined : deck.nodes.get(node.parent)
}

// The inheritance levels of a shape, nearest first (the shape's own level first), and how its placeholder matched.
export function inheritLevels(deck: Deck, node: SlideNode, shape: ShapeNode): { levels: InheritLevel[]; match: PlaceholderMatch } {
	const levels: InheritLevel[] = [{ node, shape }]

	if (shape.ph === undefined) return { levels, match: "none" }

	if (node.kind === "slide") {
		const layout = parentOf(deck, node)
		const found = layoutPlaceholder(layout, shape)

		const master = layout === undefined ? undefined : parentOf(deck, layout)

		if (layout !== undefined && found.shape !== undefined) {
			levels.push({ node: layout, shape: found.shape })

			const masterShape = masterPlaceholder(master, found.shape)

			if (master !== undefined && masterShape !== undefined) levels.push({ node: master, shape: masterShape })

			return { levels, match: found.match }
		}

		const masterShape = masterPlaceholder(master, shape)

		if (master === undefined || masterShape === undefined) return { levels, match: "none" }

		levels.push({ node: master, shape: masterShape })

		return { levels, match: "master" }
	}

	if (node.kind === "layout" || node.kind === "notes") {
		const master = parentOf(deck, node)
		const masterShape = masterPlaceholder(master, shape)

		if (master !== undefined && masterShape !== undefined) levels.push({ node: master, shape: masterShape })

		return { levels, match: masterShape === undefined ? "none" : "type" }
	}

	return { levels, match: "none" }
}

// The master a node's text styles come from.
export function masterOf(deck: Deck, node: SlideNode): SlideNode | undefined {
	let at: SlideNode | undefined = node

	for (let guard = 0; at !== undefined && guard < 4; guard++) {
		if (at.kind === "master" || at.kind === "notesMaster" || at.kind === "handoutMaster") return at

		at = parentOf(deck, at)
	}

	return undefined
}

// The master text style a shape's text starts from: notesStyle for every notes text (§19.3.1.28), else the
// master's style of its class.
export function masterTextStyle(deck: Deck, node: SlideNode, textClass: TextClass): ListStyle | undefined {
	const txStyles = masterOf(deck, node)?.txStyles

	if (txStyles === undefined) return undefined

	return node.kind === "notes" || node.kind === "notesMaster" ? txStyles.body : txStyles[textClass]
}

// The nearest level's find result, nearest first. `styled` groups (fill, line, effects) stop at a level with its own
// p:style: the style supplies them before any farther level (MS-OI29500 §2.1.1284: style link, then master shape,
// then the hard-coded default; §2.1.1374(a): the level's own spPr overrides its style).
export function nearestGroup<L extends { readonly shape: ShapeNode }, T>(
	levels: readonly L[],
	styled: boolean,
	find: (level: L) => T | undefined
): T | undefined {
	for (const level of levels) {
		const found = find(level)

		if (found !== undefined) return found
		if (styled && level.shape.style !== undefined) return undefined
	}

	return undefined
}

// Where a property group comes from: an edit's typed value, or the source element of a level's spPr.
export type GroupSource<K extends keyof ShapePropsEdit> =
	| { readonly kind: "props"; readonly value: NonNullable<ShapePropsEdit[K]>; readonly from: SlideRef }
	| { readonly kind: "source"; readonly src: SourceRef; readonly from: SlideRef }

export interface ResolvedShape {
	readonly shape: ShapeNode
	readonly node: SlideNode
	// Nearest first.
	readonly levels: readonly InheritLevel[]
	readonly match: PlaceholderMatch
	readonly xfrm: Xfrm | undefined
	// The level the xfrm came from.
	readonly xfrmFrom: SlideRef | undefined
	readonly geometry: GroupSource<"geometry"> | undefined
	readonly fill: GroupSource<"fill"> | undefined
	readonly ln: GroupSource<"ln"> | undefined
	readonly effects: GroupSource<"effects"> | undefined
	// bodyPr with every attribute resolved (ECMA defaults last).
	readonly bodyPr: TextBodyProps
	readonly textClass: TextClass
	// The list styles of the text chain, nearest first (shape, layout ph, master ph, master txStyles, defaults).
	readonly listStyles: readonly ListStyle[]
	// How many of listStyles are the shape's own lstStyle (0 or 1, first) and the master's (txStyles and
	// defaultTextStyle, last; text of the title and body classes stops at txStyles).
	readonly ownListStyles: number
	readonly masterListStyles: number
	// The nearest p:style (a non-placeholder's own; a placeholder inherits its parent's).
	readonly style: ShapeStyleRefs | undefined
}

// a:bodyPr defaults (§21.1.2.1.1): 0.1in left/right, 0.05in top/bottom insets.
export const DEFAULT_BODY_PR: TextBodyProps = {
	insets: { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 },
	anchor: "t",
	anchorCenter: false,
	vertical: "horz",
	wrap: true,
	rotation: 0,
	upright: false,
	columns: 1,
	columnSpacing: 0,
	autofit: "none",
	fontScale: 1,
	lineSpacingReduction: 0
}

const BODY_KEYS = [
	"anchor",
	"anchorCenter",
	"vertical",
	"wrap",
	"rotation",
	"upright",
	"columns",
	"columnSpacing",
	"autofit"
] as const satisfies readonly (keyof TextBodyProps)[]

// bodyPr attribute by attribute over levels nearest first (an edit's props.bodyPr before the level's text bodyPr).
// Insets resolve per side (a reader writes NaN for a side its source left out). fontScale and lnSpcReduction
// belong to the autofit choice they came with.
export function resolveBodyPr(levels: readonly Partial<TextBodyProps>[]): TextBodyProps {
	const out: { -readonly [K in keyof TextBodyProps]: TextBodyProps[K] } = { ...DEFAULT_BODY_PR, insets: { ...DEFAULT_BODY_PR.insets } }
	const insets = { left: Number.NaN, top: Number.NaN, right: Number.NaN, bottom: Number.NaN }
	const done = new Set<string>()

	for (const level of levels) {
		for (const key of BODY_KEYS) {
			if (done.has(key) || level[key] === undefined) continue

			done.add(key)
			;(out as Record<string, unknown>)[key] = level[key]

			if (key === "autofit") {
				out.fontScale = level.fontScale ?? 1
				out.lineSpacingReduction = level.lineSpacingReduction ?? 0
			}
		}

		const from = level.insets

		if (from !== undefined) {
			for (const side of ["left", "top", "right", "bottom"] as const) {
				if (Number.isNaN(insets[side]) && !Number.isNaN(from[side])) insets[side] = from[side]
			}
		}
	}

	out.insets = {
		left: Number.isNaN(insets.left) ? DEFAULT_BODY_PR.insets.left : insets.left,
		top: Number.isNaN(insets.top) ? DEFAULT_BODY_PR.insets.top : insets.top,
		right: Number.isNaN(insets.right) ? DEFAULT_BODY_PR.insets.right : insets.right,
		bottom: Number.isNaN(insets.bottom) ? DEFAULT_BODY_PR.insets.bottom : insets.bottom
	}

	return out
}

const GEOMETRY = new Set(["prstGeom", "custGeom"])
const FILLS = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])
const EFFECTS = new Set(["effectLst", "effectDag"])
const PROPERTY_CONTAINERS = new Set(["spPr", "grpSpPr"])

// The child of a shape's spPr (or grpSpPr) whose local name is in `locals`, as a SourceRef, or undefined.
function sourceGroup(docs: SourceDocuments | undefined, shape: ShapeNode, locals: ReadonlySet<string>): SourceRef | undefined {
	const src = shape.src

	if (docs === undefined || src === undefined || src.format !== "pptx") return undefined

	const document = docs.document(src.part)

	if (document === undefined || src.node < 0 || src.node >= document.count) return undefined

	for (let child = document.firstChildElement(src.node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.kinds[child] !== NodeKind.Element || !PROPERTY_CONTAINERS.has(document.localName(child))) continue

		for (let group = document.firstChildElement(child); group >= 0; group = document.nextSiblingElement(group)) {
			if (locals.has(document.localName(group))) return { ...src, node: group }
		}

		return undefined
	}

	return undefined
}

function group<K extends "geometry" | "fill" | "ln" | "effects">(
	levels: readonly InheritLevel[],
	docs: SourceDocuments | undefined,
	key: K,
	locals: ReadonlySet<string>
): GroupSource<K> | undefined {
	return nearestGroup<InheritLevel, GroupSource<K>>(levels, key !== "geometry", level => {
		const value = level.shape.props?.[key]

		if (value !== undefined) return { kind: "props", value: value as NonNullable<ShapePropsEdit[K]>, from: level.node.ref }

		const src = sourceGroup(docs, level.shape, locals)

		return src === undefined ? undefined : { kind: "source", src, from: level.node.ref }
	})
}

const LN = new Set(["ln"])

interface Memo {
	readonly key: string
	readonly docs: SourceDocuments | undefined
	readonly value: ResolvedShape
}

const memo = new WeakMap<ShapeNode, Memo>()

function memoKey(deck: Deck, levels: readonly InheritLevel[], node: SlideNode): string {
	const master = masterOf(deck, node)
	const theme = master?.theme?.revision ?? 0
	let key = `${String(deck.revision)}:${String(theme)}:${String(node.revision)}`

	for (const level of levels) key += `:${String(level.node.ref)}@${String(level.node.revision)}`

	return `${key}:${String(master?.ref ?? 0)}@${String(master?.revision ?? 0)}`
}

export function resolveShape(deck: Deck, slide: SlideRef, shape: ShapeNode, docs?: SourceDocuments): ResolvedShape {
	const node = deck.nodes.get(slide)

	if (node === undefined) throw new RangeError(`Slide ${String(slide)} is not parsed`)

	const { levels, match } = inheritLevels(deck, node, shape)
	const key = memoKey(deck, levels, node)
	const held = memo.get(shape)

	if (held !== undefined && held.key === key && held.docs === docs) return held.value

	let xfrm: Xfrm | undefined
	let xfrmFrom: SlideRef | undefined

	for (const level of levels) {
		if (level.shape.xfrm !== undefined) {
			xfrm = level.shape.xfrm
			xfrmFrom = level.node.ref

			break
		}
	}

	// The class of the placeholder the shape inherits from (a written idx may match another type's).
	const textClass = textClassOf(levels[1]?.shape ?? shape)
	const listStyles: ListStyle[] = []

	for (const level of levels) if (level.shape.text?.lstStyle !== undefined) listStyles.push(level.shape.text.lstStyle)

	const ownListStyles = shape.text?.lstStyle === undefined ? 0 : 1

	const masterStyle = masterTextStyle(deck, node, textClass)
	// Text of the title and body classes stops at the master's titleStyle or bodyStyle, then the attribute defaults;
	// text boxes and date, footer, slide-number and header placeholders (the "other" class) go on to
	// defaultTextStyle. Measured in LibreOffice 7.5 with a defaultTextStyle the txStyles leave unset; ECMA-376 and
	// MS-OI29500 §2.1.1388(a) do not name defaultTextStyle in the placeholder chain.
	// A shape that is no placeholder (a text box) takes defaultTextStyle before the master's otherStyle (PowerPoint's
	// stored a:spAutoFit heights and LibreOffice 7.5, measured: a text box under an otherStyle of 18 pt and a
	// defaultTextStyle of 24 pt is 24 pt).
	const withDefaults = masterStyle === undefined || textClass === "other"
	const masterListStyles = (masterStyle === undefined ? 0 : 1) + (withDefaults ? 1 : 0)
	const defaultsFirst = withDefaults && shape.ph === undefined && levels.length === 1

	if (defaultsFirst) listStyles.push(deck.defaultTextStyle)
	if (masterStyle !== undefined) listStyles.push(masterStyle)
	if (withDefaults && !defaultsFirst) listStyles.push(deck.defaultTextStyle)

	const bodyLevels: Partial<TextBodyProps>[] = []

	for (const level of levels) {
		if (level.shape.props?.bodyPr !== undefined) bodyLevels.push(level.shape.props.bodyPr)
		if (level.shape.text !== undefined) bodyLevels.push(level.shape.text.bodyPr)
	}

	let style: ShapeStyleRefs | undefined

	for (const level of levels) {
		if (level.shape.style !== undefined) {
			style = level.shape.style

			break
		}
	}

	const value: ResolvedShape = {
		shape,
		node,
		levels,
		match,
		xfrm,
		xfrmFrom,
		geometry: group(levels, docs, "geometry", GEOMETRY),
		fill: group(levels, docs, "fill", FILLS),
		ln: group(levels, docs, "ln", LN),
		effects: group(levels, docs, "effects", EFFECTS),
		bodyPr: resolveBodyPr(bodyLevels),
		textClass,
		listStyles,
		ownListStyles,
		masterListStyles,
		style
	}

	memo.set(shape, { key, docs, value })

	return value
}

// `top` over `base`, property by property (fills, lines and effects replace whole). Readers and edits never write a
// property as undefined, so a spread is the merge.
export function runPropsOver(base: RunProps, top: RunProps | undefined): RunProps {
	if (top === undefined) return base

	for (const key in top) if (Object.hasOwn(top, key)) return { ...base, ...top }

	return base
}

// `top` over `base`, property by property; defRPr merges run property by run property.
export function paraPropsOver(base: ParaProps, top: ParaProps | undefined): ParaProps {
	if (top === undefined) return base

	const defRPr = top.defRPr === undefined ? base.defRPr : runPropsOver(base.defRPr ?? {}, top.defRPr)
	const merged: ParaProps = { ...base, ...top }

	return defRPr === undefined ? merged : { ...merged, defRPr }
}

// Run properties property by property, nearest first.
export function mergeRunProps(levels: readonly (RunProps | undefined)[]): RunProps {
	let out: RunProps = {}

	for (let index = levels.length - 1; index >= 0; index--) out = runPropsOver(out, levels[index])

	return out
}

// Paragraph properties property by property, nearest first; defRPr merges property by property too.
export function mergeParaProps(levels: readonly (ParaProps | undefined)[]): ParaProps {
	let out: ParaProps = {}

	for (let index = levels.length - 1; index >= 0; index--) out = paraPropsOver(out, levels[index])

	return out
}

// A list style's paragraph properties at `level`. defPPr is kept for the round trip but never applied: Office
// ignores it (MS-OI29500 §2.1.1383).
export function listLevel(style: ListStyle | undefined, level: number): ParaProps | undefined {
	return style?.levels[level]
}

export interface ResolvedParagraph {
	readonly level: number
	// Every paragraph property along the chain (pPr nearest), defRPr merged.
	readonly pPr: ParaProps
}

// A paragraph's properties at its level (pPr.lvl, else `level`), through the shape's list-style chain.
export function resolveParagraph(resolved: ResolvedShape, paragraph: Paragraph, level?: number): ResolvedParagraph {
	const at = Math.max(0, Math.min(8, paragraph.pPr.lvl ?? level ?? 0))
	const chain: (ParaProps | undefined)[] = [paragraph.pPr]

	for (const style of resolved.listStyles) chain.push(listLevel(style, at))

	return { level: at, pPr: mergeParaProps(chain) }
}

// A run's properties: its rPr over the paragraph's resolved defRPr.
export function resolveRun(paragraph: ResolvedParagraph, rPr: RunProps | undefined): RunProps {
	return mergeRunProps([rPr, paragraph.pPr.defRPr])
}

// The fontRef of a non-placeholder shape's p:style (applied after the chain by the text adapter), as a FontRef of
// the theme's major or minor latin face.
export function styleFont(resolved: ResolvedShape): FontRef | undefined {
	const idx = resolved.style?.font.idx

	return idx === "major" ? { typeface: "+mj-lt" } : idx === "minor" ? { typeface: "+mn-lt" } : undefined
}

// The layout's and master's shapes that paint on a slide, back to front (master first): never placeholders, and
// only as showMasterSp on the slide (layout and master shapes) and on the layout (master shapes) allows.
export function inheritedShapes(deck: Deck, slide: SlideNode): InheritLevel[] {
	if (slide.kind !== "slide" && slide.kind !== "notes") return []
	if (!slide.showMasterShapes) return []

	const out: InheritLevel[] = []
	const layout = parentOf(deck, slide)

	if (slide.kind === "notes") {
		if (layout !== undefined) for (const shape of layout.shapes) if (shape.ph === undefined) out.push({ node: layout, shape })

		return out
	}

	const master = layout === undefined ? undefined : parentOf(deck, layout)

	if (master !== undefined && layout?.showMasterShapes !== false) {
		for (const shape of master.shapes) if (shape.ph === undefined) out.push({ node: master, shape })
	}

	if (layout !== undefined) for (const shape of layout.shapes) if (shape.ph === undefined) out.push({ node: layout, shape })

	return out
}
