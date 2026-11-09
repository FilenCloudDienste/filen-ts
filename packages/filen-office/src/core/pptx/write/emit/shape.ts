import { colorXml, effectsXml, fillXml, geometryXml, lineXml } from "../../../presentation/render/markup"
import {
	refused,
	type Action,
	type Effect,
	type EffectList,
	type FillProps,
	type LineProps,
	type Paragraph,
	type Placeholder,
	type Refused,
	type ShapeNode,
	type ShapeStyleRefs,
	type SlideNode,
	type SlideRef,
	type SourceRef,
	type StyleMatrixRef,
	type Xfrm
} from "../../../presentation/model"
import { partKey, type Relationships } from "../../../opc/index"
import { NodeKind, encodeUtf8, escapeAttribute, type XmlDocument } from "../../../xml/index"
import { readXfrm } from "../../read/drawing"
import { styleOf } from "../../read/slide"
import { G, partReader, type PartReader } from "../../read/xml"
import type { EmitPiece, EmitRequest, EmitResult, PptxEmitContext, PptxEmitFamily } from "../types"

// The shape family's PresentationML (ECMA-376 Part 1 §19.3.1: p:sp, p:cxnSp, p:grpSp, p:pic, p:graphicFrame,
// p:contentPart), and the markup helpers the slide and text families share. An element is written from the model
// where the model holds it and from its source where it does not: what the model does not hold (geometry, fills,
// lines and effects before an edit, 3-D, extension lists, unknown children) is a hole, the source element copied by
// span in its own place.
//
// Two modes. "splice" (a save into the deck's own source, given `pristine`, the part read again): a group the model
// holds is written only when it differs from what the source reads as, so untouched groups keep their bytes.
// "model" (proof gate 1, the fresh writer, any emit without `pristine`): every group the model holds is written from
// the model; only what the model does not hold comes from the source.

export type EmitMode = "splice" | "model"

// Source markup for a part other than its own (the fresh writer): start tags written with the writer's prefixes.
export interface SourceCopier {
	start(node: number): string
}

// The source part read again into the model with a fresh tally: the shapes and paragraphs as they were before any
// edit, by source node.
export interface Pristine {
	readonly part: string
	readonly epoch: number
	readonly slide: SlideNode
	readonly shapes: ReadonlyMap<number, ShapeNode>
	readonly paragraphs: ReadonlyMap<number, Paragraph>
}

export interface EmitExtras {
	readonly mode?: EmitMode
	readonly pristine?: Pristine
	readonly copier?: SourceCopier
	// The part of a slide ("/ppt/slides/slide2.xml"), for slide-jump actions.
	readonly slidePart?: (ref: SlideRef) => string | undefined
	// The family emit a writer routes a child shape to (emit.ts emitPptx by emitFamilyOf); without one, this family
	// writes every child (whatever it does not model kept as source). Given by the writers, not imported: the hub
	// imports this module.
	readonly dispatch?: (request: EmitRequest, context: EmitContext) => EmitResult
	// The source part's relationships, for reading source elements again in model mode (actions classified).
	readonly relationships?: Relationships
	// The part `document` is, when it is not the pristine read's or the owner's (a fresh write's source part).
	readonly documentPart?: string
	// Markup an undo re-read after a save's rebase ("raw:N" parts), for shapes whose source is one, and that markup
	// read again as the reader reads it (what a held shape is spliced against).
	readonly rawDocument?: (name: string) => XmlDocument | undefined
	readonly rawPristine?: (name: string) => Pristine | undefined
}

export type EmitContext = PptxEmitContext & EmitExtras

const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
export const IMAGE_RELATIONSHIP = `${RELATIONSHIPS}image`

// --- Pieces ---

export class Pieces {
	readonly out: EmitPiece[] = []

	text(markup: string): this {
		if (markup === "") return this

		const last = this.out[this.out.length - 1]

		if (typeof last === "string") this.out[this.out.length - 1] = last + markup
		else this.out.push(markup)

		return this
	}

	hole(node: number): this {
		this.out.push({ hole: node })

		return this
	}

	append(pieces: readonly EmitPiece[]): this {
		for (const piece of pieces) {
			if (typeof piece === "string") this.text(piece)
			else this.out.push(piece)
		}

		return this
	}

	markup(): EmitResult {
		return { kind: "markup", pieces: this.out }
	}
}

export function attr(name: string, value: string | number | boolean | undefined): string {
	if (value === undefined) return ""
	if (typeof value === "number" && !Number.isFinite(value)) return ""

	const text = typeof value === "boolean" ? (value ? "1" : "0") : typeof value === "number" ? String(Math.round(value)) : value

	return ` ${name}="${escapeAttribute(text)}"`
}

// --- Model comparison ---

// Structural equality of model values: `src` (where a node came from) ignored, absent and undefined alike.
export function sameModel(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b)
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false

		const left = a as unknown as ArrayLike<number>
		const right = b as unknown as ArrayLike<number>

		if (left.length !== right.length) return false

		for (let k = 0; k < left.length; k++) if (left[k] !== right[k]) return false

		return true
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false

		for (let k = 0; k < a.length; k++) if (!sameModel(a[k], b[k])) return false

		return true
	}

	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>

	for (const key of Object.keys(left)) if (key !== "src" && !sameModel(left[key], right[key])) return false
	for (const key of Object.keys(right)) if (key !== "src" && left[key] === undefined && right[key] !== undefined) return false

	return true
}

// --- Source access ---

// The node `src` names in the context's document: the same part (the pristine read's, else the emit's owner) and the
// same epoch; -1 when it is elsewhere.
export function sourceNode(context: EmitContext, src: SourceRef | undefined): number {
	if (src?.format !== "pptx" || context.document === undefined) return -1

	if (context.documentPart !== undefined) return partKey(src.part) === partKey(context.documentPart) ? src.node : -1

	const pristine = context.pristine

	if (pristine !== undefined) return partKey(src.part) === partKey(pristine.part) && src.epoch === pristine.epoch ? src.node : -1

	return partKey(src.part) === partKey(context.parts.owner) ? src.node : -1
}

export function readerOf(context: EmitContext): PartReader | undefined {
	return context.document === undefined ? undefined : partReader(context.document)
}

export function splicing(context: EmitContext): boolean {
	return (context.mode ?? (context.pristine === undefined ? "model" : "splice")) === "splice" && context.pristine !== undefined
}

// The source start tag of an element: as written, or through the copier (into another part).
export function startTag(context: EmitContext, node: number): EmitPiece {
	const document = context.document as XmlDocument

	if (context.copier !== undefined) return context.copier.start(node)

	const tag = document.bytes.subarray(document.start(node), document.openEnd(node))

	// "<a/>" opens as "<a>": its children and end tag are written after it.
	return document.isSelfClosing(node) ? concatTag(tag) : tag
}

function concatTag(tag: Uint8Array): Uint8Array {
	let end = tag.length - 2

	while (end > 0 && (tag[end - 1] === 32 || tag[end - 1] === 9 || tag[end - 1] === 10 || tag[end - 1] === 13)) end--

	const out = new Uint8Array(end + 1)

	out.set(tag.subarray(0, end))
	out[end] = 62

	return out
}

// The end tag of a source element: its name as written, or the copier's.
export function endTag(context: EmitContext, node: number): string {
	const document = context.document as XmlDocument

	if (context.copier === undefined) return `</${document.name(node)}>`

	const prefix = PREFIXES[partReader(document).group(node)]

	return `</${prefix === undefined ? document.name(node) : `${prefix}:${document.localName(node)}`}>`
}

// The prefix the writer gives each namespace group (Transitional URIs; Strict ones map to them).
export const PREFIXES: Readonly<Partial<Record<number, string>>> = {
	[G.P]: "p",
	[G.A]: "a",
	[G.R]: "r",
	[G.MC]: "mc",
	[G.P14]: "p14",
	[G.P15]: "p15",
	[G.A14]: "a14",
	[G.A16]: "a16",
	[G.Adec]: "adec",
	[G.Dgm]: "dgm",
	[G.C]: "c",
	[G.Cx]: "cx",
	[G.Asvg]: "asvg",
	[G.P188]: "p188",
	[G.P159]: "p159",
	[G.Pic]: "pic",
	[G.Dsp]: "dsp"
}

export const URIS: Readonly<Record<string, string>> = {
	p: "http://schemas.openxmlformats.org/presentationml/2006/main",
	a: "http://schemas.openxmlformats.org/drawingml/2006/main",
	r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
	p14: "http://schemas.microsoft.com/office/powerpoint/2010/main",
	p15: "http://schemas.microsoft.com/office/powerpoint/2012/main",
	a14: "http://schemas.microsoft.com/office/drawing/2010/main",
	a16: "http://schemas.microsoft.com/office/drawing/2014/main",
	adec: "http://schemas.microsoft.com/office/drawing/2017/decorative",
	dgm: "http://schemas.openxmlformats.org/drawingml/2006/diagram",
	c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
	cx: "http://schemas.microsoft.com/office/drawing/2014/chartex",
	asvg: "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
	p188: "http://schemas.microsoft.com/office/powerpoint/2018/8/main",
	p159: "http://schemas.microsoft.com/office/powerpoint/2015/09/main",
	pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
	dsp: "http://schemas.microsoft.com/office/drawing/2008/diagram"
}

export function childElements(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) out.push(child)

	return out
}

// The attributes of a source element the writer does not model, as written (` name="value"`), for a rebuilt start
// tag. Into another part, only unprefixed ones and those of the writer's own prefixes travel.
export function unmodeledAttributes(context: EmitContext, node: number, modeled: ReadonlySet<string>): string {
	const document = context.document

	if (document === undefined || node < 0) return ""

	let out = ""

	for (const attribute of document.attributes(node)) {
		const colon = attribute.name.indexOf(":")
		const prefix = colon < 0 ? "" : attribute.name.slice(0, colon)

		if (attribute.name === "xmlns" || prefix === "xmlns") {
			if (context.copier === undefined) out += attr(attribute.name, attribute.value)

			continue
		}

		if (colon < 0 && modeled.has(attribute.name)) continue
		if (colon >= 0 && context.copier !== undefined && URIS[prefix] === undefined) continue

		out += attr(attribute.name, attribute.value)
	}

	return out
}

// Children of a source element merged with the writer's. Each slot matches its source child (slots in schema order);
// a matched child is kept (a hole) or replaced, a slot without a source child is written at its schema place, and
// unknown children stay where they were.
export interface Slot {
	readonly match: (local: string, group: number) => boolean
	// The source child the slot takes, when its element is not told by its name alone (a transition inside an
	// mc:AlternateContent); `match` is not asked then.
	readonly takes?: (node: number) => boolean
	// The slot's markup given its source child (-1 when the source has none); "keep" holes the child.
	readonly write: (node: number) => "keep" | string | readonly EmitPiece[]
}

export function mergeChildren(context: EmitContext, parent: number, slots: readonly Slot[], out: Pieces): void {
	const document = context.document
	const done = new Array<boolean>(slots.length).fill(false)
	const emit = (index: number, node: number): void => {
		const slot = slots[index]

		if (slot === undefined) return

		done[index] = true

		const written = slot.write(node)

		if (written === "keep") {
			if (node >= 0) out.hole(node)
		} else if (typeof written === "string") {
			out.text(written)
		} else {
			out.append(written)
		}
	}
	const flushBefore = (index: number): void => {
		for (let k = 0; k < index; k++) if (done[k] !== true) emit(k, -1)
	}

	if (document !== undefined && parent >= 0) {
		const r = partReader(document)

		for (let child = document.firstChild(parent); child >= 0; child = document.nextSibling(child)) {
			// Whitespace, comments and processing instructions between children stay as written.
			if (document.kinds[child] !== NodeKind.Element) {
				out.hole(child)

				continue
			}

			const group = r.group(child)
			const local = document.localName(child)
			const index = slots.findIndex(slot => (slot.takes === undefined ? slot.match(local, group) : slot.takes(child)))

			// Unknown children, and a second child for a slot already taken, stay as they were.
			if (index < 0 || done[index] === true) {
				out.hole(child)

				continue
			}

			flushBefore(index)
			emit(index, child)
		}
	}

	flushBefore(slots.length)
}

// --- DrawingML values ---

const EFFECT_ORDER: readonly Effect["kind"][] = ["blur", "glow", "innerShdw", "outerShdw", "prstShdw", "reflection", "softEdge"]

// a:effectLst in schema order (CT_EffectList is a sequence).
export function effectListXml(effects: EffectList): string {
	const sorted = [...effects.effects].sort((a, b) => EFFECT_ORDER.indexOf(a.kind) - EFFECT_ORDER.indexOf(b.kind))

	return effectsXml({ effects: sorted })
}

export function xfrmXml(tag: string, xfrm: Xfrm, group: boolean): string {
	const children =
		`<a:off${attr("x", xfrm.x)}${attr("y", xfrm.y)}/><a:ext${attr("cx", Math.max(0, xfrm.cx))}${attr("cy", Math.max(0, xfrm.cy))}/>` +
		(group
			? `<a:chOff${attr("x", xfrm.chX ?? xfrm.x)}${attr("y", xfrm.chY ?? xfrm.y)}/>` +
				`<a:chExt${attr("cx", Math.max(0, xfrm.chCx ?? xfrm.cx))}${attr("cy", Math.max(0, xfrm.chCy ?? xfrm.cy))}/>`
			: "")

	return `<${tag}${xfrm.rot === 0 ? "" : attr("rot", xfrm.rot)}${xfrm.flipH ? ' flipH="1"' : ""}${xfrm.flipV ? ' flipV="1"' : ""}>${children}</${tag}>`
}

function matrixRefXml(name: string, ref: StyleMatrixRef): string {
	return `<a:${name}${attr("idx", ref.idx)}>${ref.color === undefined ? "" : colorXml(ref.color)}</a:${name}>`
}

export function styleXml(style: ShapeStyleRefs): string {
	return (
		`<p:style>${matrixRefXml("lnRef", style.ln)}${matrixRefXml("fillRef", style.fill)}${matrixRefXml("effectRef", style.effect)}` +
		`<a:fontRef${attr("idx", style.font.idx)}>${style.font.color === undefined ? "" : colorXml(style.font.color)}</a:fontRef></p:style>`
	)
}

// The image relationship of a picture fill from the owner part; undefined for an image not stored yet.
function pictureId(context: EmitContext, picture: Extract<FillProps, { kind: "picture" }>): string | undefined {
	return picture.part === undefined ? undefined : context.parts.relate(picture.part, IMAGE_RELATIONSHIP)
}

function hasUnstoredPicture(fill: FillProps | "none" | undefined): boolean {
	return fill !== undefined && fill !== "none" && fill.kind === "picture" && fill.part === undefined
}

export function fillMarkup(context: EmitContext, fill: FillProps | "none"): string | Refused {
	if (hasUnstoredPicture(fill)) return refused("notImplemented", "A picture fill whose image is not stored yet")

	return fillXml(fill, picture => pictureId(context, picture))
}

// a:ln (or a:uLn, under `tag`).
export function lineMarkup(context: EmitContext, line: LineProps | "none", tag = "a:ln"): string | Refused {
	if (line !== "none" && hasUnstoredPicture(line.fill))
		return refused("notImplemented", "A picture line fill whose image is not stored yet")

	const markup = lineXml(line, picture => pictureId(context, picture))

	return tag === "a:ln" ? markup : `<${tag}${markup.slice("<a:ln".length, markup.length - "</a:ln>".length)}</${tag}>`
}

const SHOW_JUMPS: Readonly<Record<Extract<Action, { kind: "internal" }>["jump"], string>> = {
	next: "nextslide",
	previous: "previousslide",
	first: "firstslide",
	last: "lastslide",
	lastViewed: "lastslideviewed",
	end: "endshow"
}

// a:hlinkClick / a:hlinkHover / a:hlinkMouseOver of an action; undefined when the model cannot write it (a refused
// action is only ever kept as its source; a jump to a slide without a part).
export function actionXml(context: EmitContext, tag: string, action: Action): string | undefined {
	const open = actionOpen(context, tag, action)

	return open === undefined ? undefined : closeAction(tag, action, open)
}

function closeAction(tag: string, action: Action, open: string): string {
	return action.color === "tx" ? `${open}><a:extLst>${HLINK_COLOR_EXT}</a:extLst></${tag}>` : `${open}/>`
}

// The start tag of an action's element, without its closing `/>` or `>`.
function actionOpen(context: EmitContext, tag: string, action: Action): string | undefined {
	switch (action.kind) {
		case "internal":
			return `<${tag} r:id=""${attr("action", `ppaction://hlinkshowjump?jump=${SHOW_JUMPS[action.jump]}`)}`
		case "slide": {
			const part = context.slidePart?.(action.slide)

			return part === undefined
				? undefined
				: `<${tag}${attr("r:id", context.parts.relate(part, `${RELATIONSHIPS}slide`))} action="ppaction://hlinksldjump"`
		}
		case "customShow":
			return `<${tag} r:id=""${attr("action", `ppaction://customshow?id=${String(action.id)}${action.returnAfter ? "&return=true" : ""}`)}`
		case "media":
			return `<${tag} r:id="" action="ppaction://media"`
		case "url":
			return `<${tag}${attr("r:id", context.parts.relate(action.href, `${RELATIONSHIPS}hyperlink`, true))}`
		case "refused":
			return undefined
	}
}

// The a:ext of a recoloured hyperlink: drawn in the run's text colour (ahyp:hlinkClr val="tx", [MS-ODRAWXML] 2.35.3.1).
const HLINK_COLOR_EXT =
	'<a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}"><ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/></a:ext>'

// An action written over its source element (an a:hlinkClick the model read): the model's target and verb, the
// source's other attributes (tooltip, history, highlightClick…) and children (a:snd, a:extLst) kept. A run's action
// (`colored`, the only one whose colour is read) has its colour extension follow the model's `color`: the source's
// stays when it reads as the model, else it is rewritten.
export function actionPieces(
	context: EmitContext,
	tag: string,
	action: Action,
	source: number,
	colored = false
): readonly EmitPiece[] | undefined {
	const open = actionOpen(context, tag, action)
	const document = context.document
	const r = readerOf(context)

	if (open === undefined) return undefined
	if (source < 0 || document === undefined || r === undefined) return [closeAction(tag, action, open)]

	const kept = [...document.attributes(source)]
		.filter(attribute => attribute.name !== "action" && !/(^|:)id$/u.test(attribute.name) && !attribute.name.startsWith("xmlns"))
		.map(attribute => attr(attribute.name, attribute.value))
		.join("")
	const out = new Pieces().text(`${open}${context.copier === undefined || !kept.includes(":") ? kept : ""}`)
	const extLst = r.child(source, G.A, "extLst")
	const colorExts = r.children(extLst, G.A, "ext").filter(ext => r.child(ext, G.Ahyp, "hlinkClr") >= 0)
	const first = colorExts[0]
	const sourceColor = first !== undefined && r.attr(r.child(first, G.Ahyp, "hlinkClr"), "val") === "tx" ? "tx" : undefined
	const rewrite = colored && sourceColor !== action.color
	const children = childElements(document, source)
	const added = colored && extLst < 0 && action.color === "tx"

	if (children.length === 0 && !added) return out.text("/>").out

	out.text(">")

	for (const child of children) {
		if (!rewrite || child !== extLst) {
			out.hole(child)

			continue
		}

		const others = childElements(document, extLst).filter(ext => !colorExts.includes(ext))

		if (others.length === 0 && action.color === undefined) continue

		out.text("<a:extLst>")
		for (const ext of others) out.hole(ext)
		out.text(`${action.color === "tx" ? HLINK_COLOR_EXT : ""}</a:extLst>`)
	}

	if (added) out.text(`<a:extLst>${HLINK_COLOR_EXT}</a:extLst>`)

	return out.text(`</${tag}>`).out
}

// --- Shapes ---

interface Names {
	readonly element: string
	readonly nv: string
	readonly cNv: string
}

const NAMES: Readonly<Record<ShapeNode["kind"], Names>> = {
	sp: { element: "sp", nv: "nvSpPr", cNv: "cNvSpPr" },
	cxnSp: { element: "cxnSp", nv: "nvCxnSpPr", cNv: "cNvCxnSpPr" },
	pic: { element: "pic", nv: "nvPicPr", cNv: "cNvPicPr" },
	grpSp: { element: "grpSp", nv: "nvGrpSpPr", cNv: "cNvGrpSpPr" },
	frame: { element: "graphicFrame", nv: "nvGraphicFramePr", cNv: "cNvGraphicFramePr" },
	ink: { element: "contentPart", nv: "nvContentPartPr", cNv: "cNvContentPartPr" },
	opaque: { element: "", nv: "", cNv: "" }
}

// What the source read as for this shape (splice mode only; undefined: write the model).
export function pristineOf(context: EmitContext, shape: ShapeNode): ShapeNode | undefined {
	if (!splicing(context)) return undefined

	const node = sourceNode(context, shape.src)

	return node < 0 ? undefined : context.pristine?.shapes.get(node)
}

// p:ph with what the source wrote (type obj and idx 0 are the defaults, §19.3.1.36: written when the source wrote them).
function placeholderXml(ph: Placeholder): string {
	return (
		`<p:ph${ph.type === "obj" && ph.typeWritten !== true ? "" : attr("type", ph.type)}${attr("orient", ph.orient)}${attr("sz", ph.sz)}` +
		`${ph.idx === 0 && ph.idxWritten !== true ? "" : attr("idx", ph.idx)}${attr("hasCustomPrompt", ph.hasCustomPrompt)}/>`
	)
}

const DECORATIVE_EXT = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}"

function nvSame(shape: ShapeNode, pristine: ShapeNode): boolean {
	return (
		(shape.sourceId ?? shape.id) === (pristine.sourceId ?? pristine.id) &&
		shape.name === pristine.name &&
		shape.hidden === pristine.hidden &&
		sameModel(shape.alt, pristine.alt) &&
		sameModel(shape.ph, pristine.ph) &&
		shape.txBox === pristine.txBox &&
		sameModel(shape.actions, pristine.actions)
	)
}

// p:cNvPr: id, name, alt text, hidden and actions from the model; its extension list kept.
function cNvPrXml(
	context: EmitContext,
	shape: ShapeNode,
	prefix: string,
	source: number,
	pristine: ShapeNode | undefined
): Pieces | Refused {
	const r = readerOf(context)
	const out = new Pieces().text(
		`<${prefix}:cNvPr${attr("id", shape.sourceId ?? shape.id)}${attr("name", shape.name)}${attr("descr", shape.alt?.descr)}` +
			`${shape.hidden ? ' hidden="1"' : ""}${attr("title", shape.alt?.title)}` +
			unmodeledAttributes(context, source, new Set(["id", "name", "descr", "hidden", "title"]))
	)
	const children = new Pieces()
	const sourceChild = (local: string): number => (r === undefined || source < 0 ? -1 : r.child(source, G.A, local))

	for (const [tag, action, before] of [
		["hlinkClick", shape.actions?.click, pristine?.actions?.click],
		["hlinkHover", shape.actions?.hover, pristine?.actions?.hover]
	] as const) {
		const node = sourceChild(tag)

		// Unchanged (or not writable from the model: a refused action, a jump to a slide without a part): the source.
		if (node >= 0 && (pristine === undefined ? action === undefined || action.kind === "refused" : sameModel(action, before))) {
			children.hole(node)

			continue
		}

		if (action === undefined) continue

		const markup = actionPieces(context, `a:${tag}`, action, node)

		if (markup !== undefined) children.append(markup)
		else if (node >= 0) children.hole(node)
		else return refused("unsupported", `A ${action.kind} action cannot be written from the model`)
	}

	const extLst = sourceChild("extLst")
	const decorative = shape.alt?.decorative === true
	const decorativeBefore = pristine === undefined ? decorative : pristine.alt?.decorative === true

	if (decorative === decorativeBefore) {
		if (extLst >= 0) children.hole(extLst)
		else if (decorative) children.text(decorativeXml())
	} else if (r !== undefined && extLst >= 0) {
		const kept = new Pieces()

		for (const ext of r.children(extLst, G.A, "ext")) if (r.attr(ext, "uri") !== DECORATIVE_EXT) kept.hole(ext)

		if (decorative) kept.text(decorativeExt())
		if (kept.out.length > 0) children.text("<a:extLst>").append(kept.out).text("</a:extLst>")
	} else if (decorative) {
		children.text(decorativeXml())
	}

	if (children.out.length === 0) return out.text("/>")

	return out.text(">").append(children.out).text(`</${prefix}:cNvPr>`)
}

function decorativeExt(): string {
	return `<a:ext uri="${DECORATIVE_EXT}"><adec:decorative xmlns:adec="${URIS["adec"] ?? ""}" val="1"/></a:ext>`
}

function decorativeXml(): string {
	return `<a:extLst>${decorativeExt()}</a:extLst>`
}

// The non-visual properties (p:nvSpPr…): the source when nothing in them changed (splice), else rebuilt with the
// source's other children (locks, media, custData, extLst) kept.
function nvXml(context: EmitContext, shape: ShapeNode, source: number, pristine: ShapeNode | undefined): Pieces | Refused {
	const names = NAMES[shape.kind]
	const r = readerOf(context)
	const document = context.document
	const nvGroup = shape.kind === "ink" && r !== undefined && source >= 0 && r.child(source, G.P14, names.nv) >= 0 ? G.P14 : G.P
	const prefix = nvGroup === G.P14 ? "p14" : "p"
	const nv = r === undefined || source < 0 ? -1 : r.child(source, nvGroup, names.nv)
	const out = new Pieces()

	if (nv >= 0 && pristine !== undefined && nvSame(shape, pristine)) return out.hole(nv)

	const cNvPr = cNvPrXml(context, shape, prefix, r === undefined || nv < 0 ? -1 : r.child(nv, nvGroup, "cNvPr"), pristine)

	if (!(cNvPr instanceof Pieces)) return cNvPr

	out.text(`<${prefix}:${names.nv}>`).append(cNvPr.out)

	const cNv = r === undefined || nv < 0 ? -1 : r.child(nv, nvGroup, names.cNv)
	const txBox = shape.kind === "sp" && shape.txBox === true

	// An absent txBox is false (CT_NonVisualDrawingShapeProps).
	if (cNv >= 0 && document !== undefined && (shape.kind !== "sp" || (r?.bool(cNv, "txBox") ?? false) === txBox)) {
		out.hole(cNv)
	} else if (cNv >= 0 && document !== undefined) {
		// txBox changed: the locks stay.
		const open = `<p:cNvSpPr${txBox ? ' txBox="1"' : ""}${unmodeledAttributes(context, cNv, new Set(["txBox"]))}`
		const children = [...childElements(document, cNv)]

		if (children.length === 0) out.text(`${open}/>`)
		else {
			out.text(`${open}>`)
			for (const child of children) out.hole(child)
			out.text("</p:cNvSpPr>")
		}
	} else {
		out.text(`<${prefix}:${names.cNv}${txBox ? ' txBox="1"' : ""}/>`)
	}

	const nvPr = r === undefined || nv < 0 ? -1 : r.child(nv, nvGroup, "nvPr")

	if (nvPr >= 0 && r !== undefined && document !== undefined) {
		const ph = r.child(nvPr, G.P, "ph")

		if (pristine !== undefined && sameModel(shape.ph, pristine.ph)) {
			out.hole(nvPr)
		} else {
			out.text(`<${prefix}:nvPr${unmodeledAttributes(context, nvPr, new Set())}>`)
			if (shape.ph !== undefined) out.text(placeholderXml(shape.ph))
			for (const child of childElements(document, nvPr)) if (child !== ph) out.hole(child)
			out.text(`</${prefix}:nvPr>`)
		}
	} else {
		out.text(shape.ph === undefined ? `<${prefix}:nvPr/>` : `<${prefix}:nvPr>${placeholderXml(shape.ph)}</${prefix}:nvPr>`)
	}

	return out.text(`</${prefix}:${names.nv}>`)
}

const FILL_LOCALS: ReadonlySet<string> = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])

// p:spPr / p:grpSpPr: the xfrm (when it differs) and the groups an edit set (`props`) from the model, the rest of the
// source kept.
function spPrXml(context: EmitContext, shape: ShapeNode, tag: string, source: number, pristine: ShapeNode | undefined): Pieces | Refused {
	const out = new Pieces()
	const props = shape.props
	const group = shape.kind === "grpSp"
	const r = readerOf(context)
	const sourceXfrm = r === undefined || source < 0 ? -1 : r.child(source, G.A, "xfrm")
	// The xfrm as the source reads (pristine in splice mode; read again from the element otherwise).
	const xfrmSame =
		pristine !== undefined
			? sameModel(shape.xfrm, pristine.xfrm)
			: r !== undefined && sourceXfrm >= 0 && sameModel(shape.xfrm, readXfrm(r, sourceXfrm))
	let failure: Refused | undefined

	if (source >= 0 && props === undefined && (xfrmSame || (pristine === undefined && sourceXfrm < 0 && shape.xfrm === undefined)))
		return out.hole(source)

	const value = (written: string | Refused): string => {
		if (typeof written === "string") return written

		failure = written

		return ""
	}
	const slots: Slot[] = [
		{
			match: (local, g) => g === G.A && local === "xfrm",
			write: node => (xfrmSame && node >= 0 ? "keep" : shape.xfrm === undefined ? "" : xfrmXml("a:xfrm", shape.xfrm, group))
		},
		{
			match: (local, g) => g === G.A && (local === "custGeom" || local === "prstGeom"),
			write: node =>
				props?.geometry !== undefined
					? geometryXml(props.geometry)
					: node >= 0
						? "keep"
						: source < 0 && shape.kind !== "grpSp" && shape.ph === undefined
							? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
							: ""
		},
		{
			match: (local, g) => g === G.A && FILL_LOCALS.has(local),
			write: node => (props?.fill !== undefined ? value(fillMarkup(context, props.fill)) : node >= 0 ? "keep" : "")
		},
		{
			match: (local, g) => g === G.A && local === "ln",
			write: node => (props?.ln !== undefined ? value(lineMarkup(context, props.ln)) : node >= 0 ? "keep" : "")
		},
		{
			match: (local, g) => g === G.A && (local === "effectLst" || local === "effectDag"),
			write: node => (props?.effects !== undefined ? effectListXml(props.effects) : node >= 0 ? "keep" : "")
		},
		{ match: (local, g) => g === G.A && local === "scene3d", write: () => "keep" },
		{ match: (local, g) => g === G.A && local === "sp3d", write: () => "keep" },
		{ match: (local, g) => g === G.A && local === "extLst", write: () => "keep" }
	]

	out.text(`<${tag}${unmodeledAttributes(context, source, new Set())}>`)
	mergeChildren(context, source, slots, out)

	return failure ?? out.text(`</${tag}>`)
}

// p:style as the source holds it when the model's refs are what it reads as (colour elements the model reads lossily,
// a:scrgbClr as sRGB, stay as written).
function styleSlot(context: EmitContext, shape: ShapeNode, pristine: ShapeNode | undefined, node: number): "keep" | string {
	const r = readerOf(context)

	if (node >= 0 && sameModel(shape.style, pristine !== undefined ? pristine.style : r === undefined ? undefined : styleOf(r, node)))
		return "keep"

	return shape.style === undefined ? "" : styleXml(shape.style)
}

function xfrmSlot(context: EmitContext, shape: ShapeNode, pristine: ShapeNode | undefined, tag: string, node: number): "keep" | string {
	const r = readerOf(context)

	if (node >= 0 && sameModel(shape.xfrm, pristine !== undefined ? pristine.xfrm : r === undefined ? undefined : readXfrm(r, node)))
		return "keep"

	return shape.xfrm === undefined ? "" : xfrmXml(tag, shape.xfrm, false)
}

// The text family's body writer, registered by emit/text.ts when it loads (it imports this module, so this one
// cannot import it).
let textBodyWriter: ((request: EmitRequest, context: EmitContext) => EmitResult) | undefined

export function registerTextBody(writer: (request: EmitRequest, context: EmitContext) => EmitResult): void {
	textBodyWriter = writer
}

// The text body of an sp, written by the text family.
function textSlot(context: EmitContext, shape: ShapeNode, take: (result: EmitResult) => readonly EmitPiece[]): readonly EmitPiece[] {
	if (shape.text === undefined) return []
	if (textBodyWriter === undefined) return take(refused("notImplemented", "pptx emit text"))

	const slide = context.pristine?.slide ?? NO_SLIDE

	return take(
		textBodyWriter({ slide, shape, touch: { kind: "shape", slide: slide.ref, shape: shape.id, dirt: { kind: "text" } } }, context)
	)
}

const NO_SLIDE: SlideNode = {
	ref: 0 as SlideRef,
	kind: "slide",
	part: "",
	showMasterShapes: true,
	hidden: false,
	shapes: [],
	comments: [],
	revision: 0
}

// A whole shape element, from its source element in the context's document when it has one.
export function shapeElement(context: EmitContext, shape: ShapeNode): EmitResult {
	const source = sourceNode(context, shape.src)
	const pristine = pristineOf(context, shape)
	const document = context.document
	const r = readerOf(context)

	if (shape.kind === "opaque" || (shape.lock === "alternateContent" && source >= 0)) {
		// Opaque content is only ever its source; content inside mc:AlternateContent is never rewritten here (its other
		// branch would go stale: the splice writer moves both branches).
		return source < 0 ? refused("unsupported", "Opaque content without its source") : new Pieces().hole(source).markup()
	}

	const names = NAMES[shape.kind]
	const out = new Pieces()
	let failure: Refused | undefined
	const take = (result: EmitResult | Pieces | Refused): readonly EmitPiece[] => {
		if (result instanceof Pieces) return result.out
		if (result.kind === "markup") return result.pieces
		if (result.kind === "refused") failure = result

		return []
	}
	const nv = nvXml(context, shape, source, pristine)

	if (!(nv instanceof Pieces)) return nv
	if (shape.kind === "grpSp") return groupElement(context, shape, source, nv, pristine)

	if (source < 0 || r === undefined || document === undefined) {
		// A new shape: written whole from the model.
		if (shape.kind !== "sp" && shape.kind !== "cxnSp") return refused("notImplemented", `A new ${shape.kind} shape`)

		out.text(`<p:${names.element}>`)
			.append(nv.out)
			.append(take(spPrXml(context, shape, "p:spPr", -1, undefined)))
		if (shape.style !== undefined) out.text(styleXml(shape.style))
		if (shape.kind === "sp") out.append(textSlot(context, shape, take))

		return failure ?? out.text(`</p:${names.element}>`).markup()
	}

	const slots: Slot[] = [{ match: (local, g) => (g === G.P || g === G.P14) && local === names.nv, write: () => nv.out }]
	const spPr: Slot = {
		match: (local, g) => g === G.P && local === "spPr",
		write: node => take(spPrXml(context, shape, "p:spPr", node, pristine))
	}
	const style: Slot = { match: (local, g) => g === G.P && local === "style", write: node => styleSlot(context, shape, pristine, node) }

	switch (shape.kind) {
		case "sp":
			slots.push(spPr, style, {
				match: (local, g) => g === G.P && local === "txBody",
				write: node =>
					node >= 0 && pristine !== undefined && sameTextBody(context, shape, pristine) ? "keep" : textSlot(context, shape, take)
			})
			break
		case "cxnSp":
			slots.push(spPr, style)
			break
		case "pic":
			slots.push({ match: (local, g) => g === G.P && local === "blipFill", write: () => "keep" }, spPr, style)
			break
		case "frame":
			slots.push({
				match: (local, g) => g === G.P && local === "xfrm",
				write: node => xfrmSlot(context, shape, pristine, "p:xfrm", node)
			})
			break
		case "ink": {
			const tag = r.child(source, G.P14, "xfrm") >= 0 ? "p14:xfrm" : "p:xfrm"

			slots.push({
				match: (local, g) => (g === G.P || g === G.P14) && local === "xfrm",
				write: node => xfrmSlot(context, shape, pristine, tag, node)
			})
			break
		}
	}

	out.append([startTag(context, source)])
	mergeChildren(context, source, slots, out)

	return failure ?? out.text(endTag(context, source)).markup()
}

// The body is the pristine one: every paragraph, the body properties and list style as read.
function sameTextBody(context: EmitContext, shape: ShapeNode, pristine: ShapeNode): boolean {
	return splicing(context) && sameModel(shape.text, pristine.text) && sameModel(shape.props?.bodyPr, undefined)
}

// A group: its non-visual and group properties, its children (each written by its family), the source's extLst.
function groupElement(context: EmitContext, shape: ShapeNode, source: number, nv: Pieces, pristine: ShapeNode | undefined): EmitResult {
	const out = new Pieces()
	const r = readerOf(context)
	const grpSpPr = r === undefined || source < 0 ? -1 : r.child(source, G.P, "grpSpPr")
	const spPr = spPrXml(context, shape, "p:grpSpPr", grpSpPr, pristine)

	if (!(spPr instanceof Pieces)) return spPr

	out.append(source >= 0 ? [startTag(context, source)] : ["<p:grpSp>"])
		.append(nv.out)
		.append(spPr.out)

	const children = childShapes(context, shape.children ?? [])

	if (children.kind === "refused") return children
	if (children.kind === "markup") out.append(children.pieces)

	const extLst = r === undefined || source < 0 ? -1 : r.child(source, G.P, "extLst")

	if (extLst >= 0) out.hole(extLst)

	return out.text(source >= 0 ? endTag(context, source) : "</p:grpSp>").markup()
}

// The shapes of a tree in model order: a shape inside mc:AlternateContent is the wrapper whole (once), anything else
// is written by its family; a family not built yet falls back to this one, which keeps as source what it does not
// model.
export function childShapes(context: EmitContext, shapes: readonly ShapeNode[]): EmitResult {
	const out = new Pieces()
	const wrappers = new Set<number>()

	for (const child of shapes) {
		if (child.src?.format === "pptx" && child.src.part.startsWith("raw:")) {
			const raw = rawShape(context, child)

			if (raw.kind !== "markup") return raw

			out.append(raw.pieces)

			continue
		}

		const node = sourceNode(context, child.src)
		const unit = node >= 0 ? alternateUnit(context, node) : -1

		if (unit >= 0 && wrappers.has(unit)) continue
		if (unit >= 0) {
			leadingSpace(context, unit, out)
			wrappers.add(unit)
		}

		if (unit >= 0 && unit !== node) {
			out.hole(unit)

			continue
		}

		// Unchanged since the source (splice): its element as it was.
		const pristine = pristineOf(context, child)

		if (node >= 0 && pristine !== undefined && sameShape(child, pristine)) {
			out.hole(node)

			continue
		}

		const request: EmitRequest = {
			slide: context.pristine?.slide ?? NO_SLIDE,
			shape: child,
			touch: { kind: "shape", slide: context.pristine?.slide.ref ?? (0 as SlideRef), shape: child.id, dirt: { kind: "node" } }
		}
		let result = context.dispatch === undefined ? shapeElement(context, child) : context.dispatch(request, context)

		if (result.kind === "refused" && result.reason === "notImplemented") result = shapeElement(context, child)
		if (result.kind === "refused") return result
		if (result.kind === "unchanged") {
			if (node < 0) return refused("failed", "A new shape emitted as unchanged")

			out.hole(node)

			continue
		}

		out.append(result.pieces)
	}

	return out.markup()
}

// The whitespace text right before a source element, kept with it when elements are written in a new order.
export function leadingSpace(context: EmitContext, node: number, out: Pieces): void {
	const document = context.document

	if (document === undefined || context.copier !== undefined) return

	const parent = document.parent(node)
	let previous = -1

	for (let child = document.firstChild(parent); child >= 0 && child !== node; child = document.nextSibling(child)) previous = child

	if (previous >= 0 && document.kinds[previous] === NodeKind.Text && document.text(previous).trim() === "") out.hole(previous)
}

// Two shapes alike in everything the writer models (frames and media are their sources', written as holes; a chart
// frame naming another chart than its source's is the chart family's to write).
export function sameShape(a: ShapeNode, b: ShapeNode): boolean {
	if (a.frame?.kind === "chart" && (b.frame?.kind !== "chart" || a.frame.part !== b.frame.part)) return false
	// A diagram that names other parts (an edit holds new ones) is written anew; its drawing link is a cache.
	if (
		a.frame?.kind === "smartart" &&
		(b.frame?.kind !== "smartart" ||
			a.frame.data !== b.frame.data ||
			a.frame.layout !== b.frame.layout ||
			a.frame.style !== b.frame.style ||
			a.frame.colors !== b.frame.colors)
	)
		return false
	if (
		!sameModel(
			{ ...a, frame: undefined, media: undefined, lock: undefined, children: undefined },
			{ ...b, frame: undefined, media: undefined, lock: undefined, children: undefined }
		)
	)
		return false

	const left = a.children ?? []
	const right = b.children ?? []

	return (
		left.length === right.length &&
		left.every((child, index) => {
			const other = right[index]

			return other !== undefined && sameShape(child, other)
		})
	)
}

// A shape whose source is markup the session re-read (an undo after a save): spliced against that document as it
// reads (whatever still reads as it was is copied as its bytes; model mode when it does not read), its holes resolved
// there, and handed on as bytes.
function rawShape(context: EmitContext, shape: ShapeNode): EmitResult {
	const name = shape.src?.format === "pptx" ? shape.src.part : ""
	const document = context.rawDocument?.(name)

	if (document === undefined) return refused("stale", `The source ${name} of shape ${String(shape.id)} is not held`)
	if (context.copier !== undefined)
		return refused("stale", `The source ${name} of shape ${String(shape.id)} cannot be copied into another part`)

	const { pristine: _pristine, ...rest } = context
	const held = context.rawPristine?.(name)
	const inner: EmitContext =
		held === undefined
			? { ...rest, document, documentPart: name, mode: "model" }
			: { ...rest, document, documentPart: name, mode: "splice", pristine: held }
	const request: EmitRequest = {
		slide: context.pristine?.slide ?? NO_SLIDE,
		shape,
		touch: { kind: "shape", slide: context.pristine?.slide.ref ?? (0 as SlideRef), shape: shape.id, dirt: { kind: "node" } }
	}
	let result = inner.dispatch === undefined ? shapeElement(inner, shape) : inner.dispatch(request, inner)

	if (result.kind === "refused" && result.reason === "notImplemented") result = shapeElement(inner, shape)
	if (result.kind !== "markup") return result.kind === "unchanged" ? refused("failed", "A held shape emitted as unchanged") : result

	return { kind: "markup", pieces: [joinPieces(document, result.pieces)] }
}

// Pieces as bytes, holes copied from `document` by span.
export function joinPieces(document: XmlDocument, pieces: readonly EmitPiece[]): Uint8Array {
	const chunks: Uint8Array[] = []

	for (const piece of pieces) {
		if (typeof piece === "string") chunks.push(encodeUtf8(piece))
		else if (piece instanceof Uint8Array) chunks.push(piece)
		else chunks.push(document.bytes.subarray(document.start(piece.hole), document.end(piece.hole)))
	}

	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let offset = 0

	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}

	return out
}

// The outermost mc:AlternateContent a shape's source element sits in (inside its tree), or the element itself.
export function alternateUnit(context: EmitContext, node: number): number {
	const document = context.document

	if (document === undefined) return node

	const r = partReader(document)
	let at = node

	for (let up = document.parent(node); up > 0; up = document.parent(up)) {
		if (r.is(up, G.P, "spTree") || r.is(up, G.P, "grpSp")) break
		if (r.is(up, G.MC, "AlternateContent")) at = up
	}

	return at
}

export const emitPptxShape: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		return shape === undefined ? refused("failed", "A shape emit without a shape") : shapeElement(context, shape)
	}
}
