import type { DocxModel } from "../model/document"
import type { AnchorPosition, DrawingInfo, VmlInfo, WrapType } from "../model/drawings"
import { Item, RevisionView } from "../model/kinds"
import { Ns } from "../model/namespaces"
import type { StoryPart } from "../model/part"
import { ommlToMathTree, type MathElement, type OmmlRevisionView } from "../../math/index"
import { mathBox } from "./math"
import { emu, points } from "./units"

// Everything layout places as a box: drawings, VML, equations and note separators. Drawing content is
// painted by the drawing layer; layout only needs sizes and positions, which an ObjectSizer can refine.

export const ObjectKind = {
	DRAWING: 1,
	VML: 2,
	// OMML (m:oMath, m:oMathPara), laid out as a box until the math layer measures it.
	MATH: 3,
	// The footnote separator line and the continuation separator line.
	SEPARATOR: 4,
	CONTINUATION_SEPARATOR: 5,
	// A legacy form check box (FORMCHECKBOX) as Word draws it: a square, crossed when checked (index 1).
	CHECKBOX: 6
} as const

export type ObjectKind = (typeof ObjectKind)[keyof typeof ObjectKind]

export interface ObjectSize {
	// px; ascent is the part above the baseline for inline placement (default: all of the height).
	readonly width: number
	readonly height: number
	readonly ascent?: number
}

// What an ObjectSizer is asked about.
export interface ObjectRef {
	readonly kind: ObjectKind
	readonly part: StoryPart
	readonly item: number
	readonly drawing: DrawingInfo | undefined
	readonly vml: VmlInfo | undefined
	// The font size (px) of the run holding the object, for equations.
	readonly fontSize: number
}

// A hook for the drawing and math layers: return a size to override the model's extents, or undefined.
export interface ObjectSizer {
	size(object: ObjectRef): ObjectSize | undefined
}

// Where an anchored object goes (wp:anchor, or VML position:absolute), in px.
export interface FloatSpec {
	readonly horizontalFrom: string
	readonly horizontalAlign: string | undefined
	readonly horizontalOffset: number
	readonly verticalFrom: string
	readonly verticalAlign: string | undefined
	readonly verticalOffset: number
	readonly wrap: WrapType
	readonly wrapText: string
	readonly behindDoc: boolean
	readonly allowOverlap: boolean
	readonly layoutInCell: boolean
	readonly distTop: number
	readonly distBottom: number
	readonly distLeft: number
	readonly distRight: number
	readonly zOrder: number
	// wp:wrapPolygon of tight and through wrapping: x, y pairs as fractions of the object's size.
	readonly polygon?: readonly number[] | undefined
}

// Objects by id, one per model item.
export class ObjectTable {
	count = 0
	readonly kinds: ObjectKind[] = []
	readonly parts: number[] = []
	readonly items: number[] = []
	// Index into model.drawings or model.vml; an equation holding tracked changes, the revision view it shows; -1 otherwise.
	readonly indices: number[] = []
	readonly widths: number[] = []
	readonly heights: number[] = []
	// Part above the baseline when inline.
	readonly ascents: number[] = []
	// Present for anchored objects.
	readonly floats: (FloatSpec | undefined)[] = []
	// Text box stories inside, in order.
	readonly textboxes: (readonly number[] | undefined)[] = []
	// Insets of a text box (left, top, right, bottom px).
	readonly insets: (readonly number[] | undefined)[] = []
	// How a text box's text runs (wps:bodyPr@vert, ST_TextVerticalType), undefined for horizontal text.
	readonly verticals: (string | undefined)[] = []
	// Equations measured while a font was still loading: measured again once fonts are in.
	readonly provisional = new Set<number>()
	private readonly byItem = new Map<number, number>()

	// Equations holding tracked changes, by item and revision view: each view shows them otherwise.
	private readonly byView = new Map<number, number>()

	idOf(part: number, item: number): number {
		return this.byItem.get(part * 0x4000000 + item) ?? -1
	}

	// The equation at `item` as revision view `view` shows it (its index is the view), or -1.
	viewIdOf(part: number, item: number, view: RevisionView): number {
		return this.byView.get((part * 0x4000000 + item) * 4 + view) ?? -1
	}

	setViewId(part: number, item: number, view: RevisionView, id: number): void {
		this.byView.set((part * 0x4000000 + item) * 4 + view, id)
	}

	add(
		kind: ObjectKind,
		part: number,
		item: number,
		index: number,
		width: number,
		height: number,
		ascent: number,
		float: FloatSpec | undefined,
		textboxes: readonly number[] | undefined,
		insets: readonly number[] | undefined,
		vertical?: string
	): number {
		const id = this.count++

		this.kinds.push(kind)
		this.parts.push(part)
		this.items.push(item)
		this.indices.push(index)
		this.widths.push(width)
		this.heights.push(height)
		this.ascents.push(ascent)
		this.floats.push(float)
		this.textboxes.push(textboxes)
		this.insets.push(insets)
		this.verticals.push(vertical)

		if (item >= 0) this.byItem.set(part * 0x4000000 + item, id)

		return id
	}
}

function position(position: AnchorPosition | undefined, horizontal: boolean): { from: string; align: string | undefined; offset: number } {
	return {
		from: position?.relativeFrom ?? (horizontal ? "column" : "paragraph"),
		align: position?.align,
		offset: emu(position?.offset ?? 0)
	}
}

// Word's wrap polygon coordinates: 21600 spans the object.
const POLYGON_UNITS = 21600

// The wrap polygon of a tight or through wrapping anchor, normalized; undefined without one.
function wrapPolygon(part: StoryPart, frame: number): number[] | undefined {
	const reader = part.reader
	const document = part.document
	const wrap = Math.max(reader.child(frame, Ns.WP, "wrapTight"), reader.child(frame, Ns.WP, "wrapThrough"))
	const polygon = wrap < 0 ? -1 : reader.child(wrap, Ns.WP, "wrapPolygon")

	if (polygon < 0) return undefined

	const points: number[] = []

	for (let child = document.firstChildElement(polygon); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "start" || local === "lineTo")
			points.push(reader.int(child, Ns.None, "x", 0) / POLYGON_UNITS, reader.int(child, Ns.None, "y", 0) / POLYGON_UNITS)
	}

	return points.length >= 6 ? points : undefined
}

function drawingFloat(drawing: DrawingInfo, part: StoryPart): FloatSpec | undefined {
	const anchor = drawing.anchor

	if (anchor === undefined) return undefined

	const polygon = anchor.wrap === "tight" || anchor.wrap === "through" ? wrapPolygon(part, drawing.frame) : undefined

	if (anchor.simplePos) {
		return {
			horizontalFrom: "page",
			horizontalAlign: undefined,
			horizontalOffset: emu(anchor.simpleX),
			verticalFrom: "page",
			verticalAlign: undefined,
			verticalOffset: emu(anchor.simpleY),
			wrap: anchor.wrap,
			wrapText: anchor.wrapText ?? "bothSides",
			behindDoc: anchor.behindDoc,
			allowOverlap: anchor.allowOverlap,
			layoutInCell: anchor.layoutInCell,
			distTop: emu(drawing.distTop),
			distBottom: emu(drawing.distBottom),
			distLeft: emu(drawing.distLeft),
			distRight: emu(drawing.distRight),
			zOrder: anchor.relativeHeight,
			polygon
		}
	}

	const h = position(anchor.horizontal, true)
	const v = position(anchor.vertical, false)

	return {
		horizontalFrom: h.from,
		horizontalAlign: h.align,
		horizontalOffset: h.offset,
		verticalFrom: v.from,
		verticalAlign: v.align,
		verticalOffset: v.offset,
		wrap: anchor.wrap,
		wrapText: anchor.wrapText ?? "bothSides",
		behindDoc: anchor.behindDoc,
		allowOverlap: anchor.allowOverlap,
		layoutInCell: anchor.layoutInCell,
		distTop: emu(drawing.distTop),
		distBottom: emu(drawing.distBottom),
		distLeft: emu(drawing.distLeft),
		distRight: emu(drawing.distRight),
		zOrder: anchor.relativeHeight,
		polygon
	}
}

// CSS-like lengths in VML style attributes.
function vmlLength(value: string | undefined): number | undefined {
	if (value === undefined) return undefined

	const match = /^\s*(-?[\d.]+)\s*(pt|in|cm|mm|px|pc|emu)?\s*$/.exec(value)

	if (match === null) return undefined

	const n = Number(match[1])

	if (!Number.isFinite(n)) return undefined

	switch (match[2]) {
		case "in":
			return n * 96
		case "cm":
			return (n * 96) / 2.54
		case "mm":
			return (n * 96) / 25.4
		case "pc":
			return n * 16
		case "pt":
			return points(n)
		case "emu":
			return emu(n)
		default:
			// Unitless VML lengths are EMU-free pixels in Word's output.
			return n
	}
}

function vmlStyle(style: string | undefined): Map<string, string> {
	const out = new Map<string, string>()

	if (style === undefined) return out

	for (const declaration of style.split(";")) {
		const colon = declaration.indexOf(":")

		if (colon > 0) out.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim())
	}

	return out
}

const VML_WRAPS: Readonly<Record<string, WrapType>> = {
	square: "square",
	tight: "tight",
	through: "through",
	topAndBottom: "topAndBottom",
	none: "none"
}

export function textboxStories(model: DocxModel, part: StoryPart, item: number): number[] | undefined {
	let out: number[] | undefined

	for (let child = item + 1; child < part.end(item); child = part.end(child)) {
		if (part.kinds[child] !== Item.Textbox) continue

		const story = model.storyOf(part, child)

		if (story !== undefined) (out ??= []).push(story.index)
	}

	return out
}

// wps:bodyPr insets (EMU; defaults 0.1 in left and right, 0.05 in top and bottom).
function drawingInsets(part: StoryPart, drawing: DrawingInfo): number[] {
	const reader = part.reader
	const bodyPr = drawing.graphicData < 0 ? -1 : reader.descendant(drawing.graphicData, Ns.Wps, "bodyPr")
	const inset = (name: string, fallback: number): number => emu(bodyPr < 0 ? fallback : reader.int(bodyPr, Ns.None, name, fallback))

	return [inset("lIns", 91440), inset("tIns", 45720), inset("rIns", 91440), inset("bIns", 45720)]
}

// wps:bodyPr@vert (ST_TextVerticalType, ECMA-376 §20.1.10.83): how the text box's text runs, undefined for "horz".
function drawingVertical(part: StoryPart, drawing: DrawingInfo): string | undefined {
	const reader = part.reader
	const bodyPr = drawing.graphicData < 0 ? -1 : reader.descendant(drawing.graphicData, Ns.Wps, "bodyPr")
	const value = bodyPr < 0 ? undefined : reader.attr(bodyPr, Ns.None, "vert")

	return value === undefined || value === "horz" ? undefined : value
}

const VIEW_NAMES: Readonly<Record<RevisionView, OmmlRevisionView["view"]>> = {
	[RevisionView.Markup]: "markup",
	[RevisionView.Final]: "final",
	[RevisionView.Original]: "original"
}

// How revision view `view` shows tracked changes inside equations.
export function equationView(view: RevisionView): OmmlRevisionView {
	return { view: VIEW_NAMES[view] }
}

const W_CHANGES: ReadonlySet<string> = new Set(["ins", "del", "moveFrom", "moveTo"])
const trackedEquations = new WeakMap<StoryPart, Map<number, boolean>>()

// Whether the equation at `item` holds tracked changes (w:ins / w:del anywhere in it); read once per item.
export function equationTracked(part: StoryPart, item: number): boolean {
	let known = trackedEquations.get(part)

	if (known === undefined) {
		known = new Map()
		trackedEquations.set(part, known)
	}

	let tracked = known.get(item)

	if (tracked !== undefined) return tracked

	const document = part.document
	const reader = part.reader
	// Iterative: an equation may nest deeper than the stack goes.
	const visit = (root: number): boolean => {
		const stack = [root]

		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			for (let child = document.firstChildElement(next); child >= 0; child = document.nextSiblingElement(child)) {
				if (reader.group(child) === Ns.W && W_CHANGES.has(document.localName(child))) return true

				stack.push(child)
			}
		}

		return false
	}

	tracked = visit(part.node(item))
	known.set(item, tracked)

	return tracked
}

const equationAuthorLists = new WeakMap<StoryPart, readonly string[]>()

// The authors of the tracked changes inside a part's equations, in document order (read once per part): reviewers
// are numbered from the model (styles.ts revisionAuthors), so the colour of one who changed only equations is the
// same wherever it is drawn.
export function equationAuthors(part: StoryPart): readonly string[] {
	let found = equationAuthorLists.get(part)

	if (found !== undefined) return found

	const out: string[] = []
	const document = part.document
	const reader = part.reader
	// In document order, iteratively: an equation may nest deeper than the stack goes.
	const visit = (root: number): void => {
		const stack = [root]

		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			const children: number[] = []

			for (let child = document.firstChildElement(next); child >= 0; child = document.nextSiblingElement(child)) {
				if (reader.group(child) === Ns.W && W_CHANGES.has(document.localName(child))) {
					const author = reader.attr(child, Ns.W, "author")

					if (author !== undefined) out.push(author)
				}

				children.push(child)
			}

			for (let k = children.length - 1; k >= 0; k--) stack.push(children[k] ?? -1)
		}
	}

	for (let item = 0; item < part.kinds.length; item++) {
		const kind = part.kinds[item]

		if ((kind === Item.Math || kind === Item.MathParagraph) && equationTracked(part, item)) visit(part.node(item))
	}

	found = out
	equationAuthorLists.set(part, found)

	return found
}

// An equation's size from its MathML tree, its text measured in the run's font; for a tree that cannot be
// built, its text one and a half lines high. `view`: how its tracked changes show.
function equationSize(
	part: StoryPart,
	item: number,
	display: boolean,
	fontSize: number,
	measureText: (text: string) => number,
	view: OmmlRevisionView | undefined
): ObjectSize {
	const node = part.node(item)
	let tree: MathElement | undefined

	try {
		tree = ommlToMathTree(part.document, node, {
			namespaces: part.reader.namespaces,
			...(view === undefined ? {} : { revisions: view })
		})
	} catch {
		tree = undefined
	}

	if (tree === undefined) {
		const height = fontSize * 1.5

		return { width: measureText(part.document.textContent(node)), height, ascent: height * 0.75 }
	}

	const box = mathBox(tree, fontSize, display, (text, size) => (fontSize > 0 ? (measureText(text) * size) / fontSize : 0))

	return { width: box.width, height: box.ascent + box.descent, ascent: box.ascent }
}

export interface PlacedObject {
	readonly id: number
	readonly width: number
	readonly height: number
	readonly ascent: number
	readonly anchored: boolean
}

// Registers (once) and sizes the drawing, VML or equation at `item`. `fontsMissing`: fonts are still loading,
// so an equation measured now is measured again later. An equation holding tracked changes is an object per
// revision view `view` (each shows it otherwise; the object's index is the view).
export function objectAt(
	model: DocxModel,
	table: ObjectTable,
	sizer: ObjectSizer | undefined,
	part: StoryPart,
	item: number,
	fontSize: number,
	measureText: (text: string) => number,
	fontsMissing: boolean,
	view: RevisionView = RevisionView.Final
): PlacedObject | undefined {
	const kind = part.kinds[item]
	const tracked = (kind === Item.Math || kind === Item.MathParagraph) && equationTracked(part, item)
	const existing = tracked ? table.viewIdOf(part.index, item, view) : table.idOf(part.index, item)

	if (existing >= 0 && (fontsMissing || !table.provisional.has(existing))) {
		return {
			id: existing,
			width: table.widths[existing] ?? 0,
			height: table.heights[existing] ?? 0,
			ascent: table.ascents[existing] ?? 0,
			anchored: table.floats[existing] !== undefined
		}
	}

	if (kind === Item.Drawing) {
		const drawing = model.drawings[part.aux[item] ?? -1]

		if (drawing === undefined || drawing.hidden) return undefined

		const float = drawingFloat(drawing, part)
		const anchored = float !== undefined
		const custom = sizer?.size({ kind: ObjectKind.DRAWING, part, item, drawing, vml: undefined, fontSize })
		// Inline objects take their effect extent too (shadows and glow push the text away).
		const width = custom?.width ?? emu(drawing.width + (anchored ? 0 : drawing.effectLeft + drawing.effectRight))
		const height = custom?.height ?? emu(drawing.height + (anchored ? 0 : drawing.effectTop + drawing.effectBottom))
		const textboxes = drawing.textboxes > 0 ? textboxStories(model, part, item) : undefined
		const id = table.add(
			ObjectKind.DRAWING,
			part.index,
			item,
			drawing.index,
			width,
			height,
			custom?.ascent ?? height,
			float,
			textboxes,
			textboxes === undefined ? undefined : drawingInsets(part, drawing),
			textboxes === undefined ? undefined : drawingVertical(part, drawing)
		)

		return { id, width, height, ascent: custom?.ascent ?? height, anchored }
	}

	if (kind === Item.VmlPicture || kind === Item.EmbeddedObject) {
		const vml = model.vml[part.aux[item] ?? -1]

		if (vml === undefined) return undefined

		const reader = part.reader
		const style = vmlStyle(vml.shape < 0 ? undefined : reader.attr(vml.shape, Ns.None, "style"))

		if (style.get("visibility") === "hidden" || style.get("display") === "none") return undefined

		const custom = sizer?.size({ kind: ObjectKind.VML, part, item, drawing: undefined, vml, fontSize })
		const width = custom?.width ?? vmlLength(style.get("width")) ?? 0
		const height = custom?.height ?? vmlLength(style.get("height")) ?? 0
		let float: FloatSpec | undefined

		if (style.get("position") === "absolute") {
			const wrapNode = vml.shape < 0 ? -1 : reader.child(vml.shape, Ns.W10, "wrap")
			const wrapType = wrapNode < 0 ? undefined : reader.attr(wrapNode, Ns.None, "type")
			const z = Number(style.get("z-index") ?? "0")

			float = {
				horizontalFrom: style.get("mso-position-horizontal-relative") ?? "column",
				horizontalAlign: style.get("mso-position-horizontal"),
				horizontalOffset: vmlLength(style.get("margin-left") ?? style.get("left")) ?? 0,
				verticalFrom: style.get("mso-position-vertical-relative") ?? "paragraph",
				verticalAlign: style.get("mso-position-vertical"),
				verticalOffset: vmlLength(style.get("margin-top") ?? style.get("top")) ?? 0,
				wrap: wrapType === undefined ? "none" : (VML_WRAPS[wrapType] ?? "square"),
				wrapText: "bothSides",
				behindDoc: Number.isFinite(z) && z < 0,
				allowOverlap: true,
				layoutInCell: true,
				distTop: 0,
				distBottom: 0,
				distLeft: points(9),
				distRight: points(9),
				zOrder: Number.isFinite(z) ? z : 0
			}
		}

		const textboxes = vml.textboxes > 0 ? textboxStories(model, part, item) : undefined
		const id = table.add(
			ObjectKind.VML,
			part.index,
			item,
			vml.index,
			width,
			height,
			custom?.ascent ?? height,
			float,
			textboxes,
			textboxes === undefined ? undefined : [9.6, 4.8, 9.6, 4.8]
		)

		return { id, width, height, ascent: custom?.ascent ?? height, anchored: float !== undefined }
	}

	if (kind === Item.Math || kind === Item.MathParagraph) {
		const custom = sizer?.size({ kind: ObjectKind.MATH, part, item, drawing: undefined, vml: undefined, fontSize })
		const estimated =
			custom === undefined
				? equationSize(part, item, kind === Item.MathParagraph, fontSize, measureText, tracked ? equationView(view) : undefined)
				: undefined
		const width = custom?.width ?? estimated?.width ?? 0
		const height = custom?.height ?? estimated?.height ?? 0
		const ascent = custom?.ascent ?? estimated?.ascent ?? height

		if (existing >= 0) {
			table.widths[existing] = width
			table.heights[existing] = height
			table.ascents[existing] = ascent
			table.provisional.delete(existing)

			return { id: existing, width, height, ascent, anchored: false }
		}

		const id = table.add(ObjectKind.MATH, part.index, item, tracked ? view : -1, width, height, ascent, undefined, undefined, undefined)

		if (tracked) table.setViewId(part.index, item, view, id)
		if (fontsMissing) table.provisional.add(id)

		return { id, width, height, ascent, anchored: false }
	}

	return undefined
}
