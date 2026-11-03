import { appendAll } from "../../../arrays"
import type { EmitPiece, EmitRequest, EmitResult } from "../../../pptx/write/types"
import {
	refused,
	type Action,
	type Geometry,
	type PlaceholderType,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type Xfrm
} from "../../../presentation/model"
import { NodeKind, decodeUtf8, encodeUtf8, escapeAttribute, escapeText } from "../../../xml/index"
import { inScope, rootScope } from "../../../anim/prune"
import type { Fragment } from "../../read/context"
import type { OdpEmitContext, OdpEmitFamily } from "../emit"
import { odpTargetId, odpTargetIds } from "../../../anim/odf"
import {
	OdpStyles,
	WRITTEN_NAMESPACES,
	bodyChanges,
	declared,
	cm,
	effectChanges,
	FILL_PROPERTIES,
	fillChanges,
	lineChanges,
	setProperty,
	styleChanges,
	type StyleChanges
} from "../styles"
import { odfCustomAttributes, odfPresetAttributes, odfPresetGeometry, presetDependsOnSize } from "../../../odf/presetShapes"
import { parseLength } from "../../../odf/index"
import { transformMatrix, xfrmOf } from "../../read/shapes"
import { resourceFillChanges, resourceLineChanges } from "../resources"
import { LENGTHS, changedLengths, emuOf } from "./box"
import { textScaleOf } from "../../../presentation/edit/apply/design"
import { keptTextNames, odpKeptTextMarkup, odpScaledTextChanges, type KeptTextNames } from "./design"
import { isRefused } from "../../../presentation/refusal"

// A shape as ODF drawing markup (ODF 1.3 Part 3 §10.3 draw:frame, §10.6 draw:custom-shape, §10.4 shapes, §10.3.14
// draw:g). A shape the source has is patched, never rewritten: its start tag keeps every attribute the edit did not
// change, its children the edit did not touch are copied by span (holes), and its style is a patched copy of its own
// (styles.ts). What changes, by aspect:
//   - box: svg:x/y/width/height, and draw:transform "rotate (a) translate (x y)" for a turned box (§19.229; the reader
//     takes it apart into DrawingML's offset, extent and rotation about the centre); a line's svg:x1/y1/x2/y2; a
//     group has no box of its own: its members are written where the group's mapping puts them;
//   - fill, line, shadow and text area: the style;
//   - text: the paragraphs (emit/text.ts), in the frame's draw:text-box or the shape itself;
//   - name, visibility, title and description, click action (§19.124 draw:display, §10.3.2 svg:title,
//     §10.4.2 office:event-listeners with presentation:event-listener §10.4.3).
// A shape an op made is written whole from the model. Shapes of other families (pictures, tables, charts, media)
// are patched here for their box and the attributes every shape shares; their content is their family's.

// x' = a·x + c·y + e, y' = b·x + d·y + f (EMU).
export interface Affine {
	readonly a: number
	readonly b: number
	readonly c: number
	readonly d: number
	readonly e: number
	readonly f: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function isIdentity(m: Affine): boolean {
	return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
}

// m after n.
export function compose(m: Affine, n: Affine): Affine {
	return {
		a: m.a * n.a + m.c * n.b,
		b: m.b * n.a + m.d * n.b,
		c: m.a * n.c + m.c * n.d,
		d: m.b * n.c + m.d * n.d,
		e: m.a * n.e + m.c * n.f + m.e,
		f: m.b * n.e + m.d * n.f + m.f
	}
}

function apply(m: Affine, x: number, y: number): [number, number] {
	return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]
}

// A group's mapping of its members' space (chOff/chExt) onto its own box, mirrored (flipH, flipV) and then turned about
// the box's centre (ECMA-376 §20.1.7.6, the group's own transform after its child space).
export function groupAffine(xfrm: Xfrm | undefined): Affine | Refused {
	if (xfrm === undefined) return IDENTITY

	const chX = xfrm.chX ?? xfrm.x
	const chY = xfrm.chY ?? xfrm.y
	const chCx = xfrm.chCx ?? xfrm.cx
	const chCy = xfrm.chCy ?? xfrm.cy
	const sx = chCx === 0 ? 1 : xfrm.cx / chCx
	const sy = chCy === 0 ? 1 : xfrm.cy / chCy
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2
	let scale: Affine = { a: sx, b: 0, c: 0, d: sy, e: xfrm.x - chX * sx, f: xfrm.y - chY * sy }

	if (xfrm.flipH || xfrm.flipV) {
		const mirror: Affine = {
			a: xfrm.flipH ? -1 : 1,
			b: 0,
			c: 0,
			d: xfrm.flipV ? -1 : 1,
			e: xfrm.flipH ? 2 * cx : 0,
			f: xfrm.flipV ? 2 * cy : 0
		}

		scale = compose(mirror, scale)
	}

	if (xfrm.rot === 0) return scale

	const radians = (xfrm.rot / 60_000) * (Math.PI / 180)
	const cos = Math.cos(radians)
	const sin = Math.sin(radians)
	const turn: Affine = { a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy }

	return compose(turn, scale)
}

// A box placed by `m`: its centre mapped, its extents scaled, its turn added (a mapping that only scales, moves and
// turns, as a group's does).
export function placed(xfrm: Xfrm, m: Affine): Xfrm {
	if (isIdentity(m)) return xfrm

	const [x, y] = apply(m, xfrm.x + xfrm.cx / 2, xfrm.y + xfrm.cy / 2)
	const sx = Math.hypot(m.a, m.b)
	const sy = Math.hypot(m.c, m.d)
	const cx = Math.round(xfrm.cx * sx)
	const cy = Math.round(xfrm.cy * sy)
	const turnOf = (radians: number): number => Math.round(((radians * 180) / Math.PI) * 60_000)
	const angle = (rot: number): number => ((rot % 21_600_000) + 21_600_000) % 21_600_000
	const box = { x: Math.round(x - cx / 2), y: Math.round(y - cy / 2), cx, cy }

	if (m.a * m.d - m.b * m.c >= 0)
		return { ...box, rot: angle(xfrm.rot + turnOf(Math.atan2(m.b, m.a))), flipH: xfrm.flipH, flipV: xfrm.flipV }

	// A mirroring mapping (a mirrored group's): a turn after one mirror, the box's own turn then running the other way.
	// Of the two ways to say it (a vertical mirror turned by atan2(b, a), a horizontal one by atan2(-b, -a)), the one
	// with the smaller turn, as LibreOffice writes a mirrored group's members.
	const vertical = Math.atan2(m.b, m.a)
	const horizontal = Math.atan2(-m.b, -m.a)

	return Math.abs(horizontal) < Math.abs(vertical) - 1e-9
		? { ...box, rot: angle(turnOf(horizontal) - xfrm.rot), flipH: !xfrm.flipH, flipV: xfrm.flipV }
		: { ...box, rot: angle(turnOf(vertical) - xfrm.rot), flipH: xfrm.flipH, flipV: !xfrm.flipV }
}

// The box an ODF element holds for a shape's flips, under DrawingML's meaning of them (a horizontal flip leaves text
// as it reads, a vertical one turns it half a turn): a rectangle (a text frame, or any outline that is one) mirrored is
// itself, so it holds the turn alone; a frame of a table, chart, medium or object holds no flip (PowerPoint draws none
// on a graphic frame); a picture holds a horizontal flip as style:mirror, any other outline its flips as draw:mirror-*.
export function canonicalBox(shape: ShapeNode, box: Xfrm): Xfrm {
	if (!box.flipH && !box.flipV) return box
	// LibreOffice 7.5 mirrors a picture only horizontally (it reads style:mirror="vertical" as none): a vertical flip is
	// a horizontal one half a turn round, as its pptx import writes it.
	if (shape.kind === "pic") return box.flipV ? { ...box, rot: (box.rot + 10_800_000) % 21_600_000, flipH: !box.flipH, flipV: false } : box
	if (shape.kind === "grpSp" || shape.kind === "cxnSp") return box
	if (shape.kind === "frame") return { ...box, flipH: false, flipV: false }

	const geometry = shape.props?.geometry

	// A rectangle, rounded rectangle or ellipse mirrored is itself.
	if (geometry !== undefined && !(geometry.kind === "preset" && SYMMETRIC.has(geometry.preset))) return box

	return { ...box, rot: box.flipV ? (box.rot + 10_800_000) % 21_600_000 : box.rot, flipH: false, flipV: false }
}

const SYMMETRIC: ReadonlySet<string> = new Set(["rect", "roundRect", "ellipse"])

// A picture's horizontal flip (canonicalBox turns a vertical one into it) as its graphic style's style:mirror (ODF 1.3
// Part 3 §20.355); undefined for none.
export function pictureMirror(box: Xfrm): string | undefined {
	return box.flipH ? "horizontal" : undefined
}

// A line's ends where `m` puts them (DrawingML's box with its flips and turn, §20.1.7.6).
export function lineEnds(xfrm: Xfrm, m: Affine): [number, number, number, number] {
	const radians = (xfrm.rot / 60_000) * (Math.PI / 180)
	const cos = Math.cos(radians)
	const sin = Math.sin(radians)
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2
	const end = (fx: number, fy: number): [number, number] => {
		const dx = (fx - 0.5) * xfrm.cx
		const dy = (fy - 0.5) * xfrm.cy

		return apply(m, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
	}
	const [x1, y1] = end(xfrm.flipH ? 1 : 0, xfrm.flipV ? 1 : 0)
	const [x2, y2] = end(xfrm.flipH ? 0 : 1, xfrm.flipV ? 0 : 1)

	return [x1, y1, x2, y2]
}

// What of a shape differs from its source.
export interface Aspects {
	readonly xfrm?: boolean
	readonly fill?: boolean
	readonly ln?: boolean
	readonly effects?: boolean
	readonly bodyPr?: boolean
	readonly geometry?: boolean
	readonly text?: boolean
	readonly alt?: boolean
	readonly name?: boolean
	readonly hidden?: boolean
	readonly actions?: boolean
	// The frame's content (a table's cells): its family writes the element.
	readonly frame?: boolean
	// The shape as the source holds it (what a line's ends and dashes were).
	readonly pristine?: ShapeNode
}

const ALL: Aspects = {
	xfrm: true,
	fill: true,
	ln: true,
	effects: true,
	bodyPr: true,
	geometry: true,
	text: true,
	alt: true,
	name: true,
	hidden: true,
	actions: true
}

function aspectsOfDirt(request: EmitRequest): Aspects {
	const touch = request.touch
	const dirt = touch.kind === "shape" || touch.kind === "slide" ? touch.dirt : undefined

	switch (dirt?.kind) {
		case "xfrm":
			return { xfrm: true }
		case "text":
			return { text: true }
		case "props":
			return dirt.group === "style" ? {} : { [dirt.group]: true }
		default:
			return ALL
	}
}

export function hasAspects(aspects: Aspects | undefined): boolean {
	if (aspects === undefined) return false

	for (const [key, value] of Object.entries(aspects)) if (key !== "pristine" && value === true) return true

	return false
}

// The shape family's emit: one shape's element, the source's patched for the request's dirt, or written whole.
export const emitOdpShape: OdpEmitFamily = {
	emit(request, context) {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "a shape emit without a shape")
		if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

		const writer = new OdpShapeWriter(
			context,
			context.document === undefined ? undefined : context.styles.env.fragmentOf(context.document),
			request.slide,
			() => undefined
		)
		const aspects = aspectsOfDirt(request)
		const pieces = writer.element(shape, IDENTITY, aspects, true)

		return isRefused(pieces) ? pieces : { kind: "markup", pieces }
	}
}

const CLASS_OF: Partial<Record<PlaceholderType, string>> = {
	title: "title",
	ctrTitle: "title",
	subTitle: "subtitle",
	body: "outline",
	obj: "object",
	pic: "graphic",
	chart: "chart",
	tbl: "table",
	dgm: "orgchart",
	sldImg: "page",
	hdr: "header",
	ftr: "footer",
	dt: "date-time",
	sldNum: "page-number"
}

const STYLE_SUFFIX: Readonly<Record<string, string>> = { title: "title", subtitle: "subtitle", outline: "outline1", notes: "notes" }

// Elements whose box is svg:x/y/width/height (with draw:transform).
const BOXED: ReadonlySet<string> = new Set([
	"draw:frame",
	"draw:custom-shape",
	"draw:rect",
	"draw:ellipse",
	"draw:circle",
	"draw:polygon",
	"draw:polyline",
	"draw:path",
	"draw:regular-polygon",
	"draw:caption",
	"draw:control",
	"draw:page-thumbnail",
	"dr3d:scene"
])

const LINES: ReadonlySet<string> = new Set(["draw:line", "draw:connector", "draw:measure"])
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(["text:p", "text:h", "text:list"])

export interface AttributeChange {
	// Canonical name ("svg:x"); written with the element's own prefix for the namespace.
	readonly name: string
	readonly value: string | null
}

// The attributes a style's fill is written in, with the draw:transparency fillChanges takes out.
const FILL_ATTRIBUTES: readonly string[] = [...FILL_PROPERTIES, "draw:transparency"]

// A start tag: its name (group 1) and its attributes.
const START_TAG = /^(<[^\s/>]+)(?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*/u

// Writes the shapes of one page (or of a notes page) as markup: patched source elements, copies by span, new ones.
export class OdpShapeWriter {
	readonly context: OdpEmitContext
	readonly styles: OdpStyles
	readonly fragment: Fragment | undefined
	readonly slide: SlideNode
	// Writing a member that moves into a new group (its start tag gains the xml:id its draw:id lacks).
	private grouping = false
	// Each shape's aspects that differ from its source (undefined: none).
	private readonly aspectsOf: (shape: ShapeNode) => Aspects | undefined
	private readonly idPrefix: string
	// The shapes the slide's timing animates (walked once a writer).
	private targets: ReadonlySet<number> | undefined = undefined
	// The scaled copies of kept shapes' text styles this writer made (odpKeptTextMarkup).
	private readonly keptNames: KeptTextNames = keptTextNames()

	constructor(
		context: OdpEmitContext,
		fragment: Fragment | undefined,
		slide: SlideNode,
		aspectsOf: (shape: ShapeNode) => Aspects | undefined,
		// What new target ids start with (core/anim/odf.ts OdpTimingContext.idPrefix).
		idPrefix = ""
	) {
		this.idPrefix = idPrefix
		this.context = context
		this.styles = context.styles as OdpStyles
		this.fragment = fragment
		this.slide = slide
		this.aspectsOf = aspectsOf
	}

	// The source element a shape's src names in this fragment, or undefined (a shape an op made, or of another page).
	sourceNode(shape: ShapeNode): number | undefined {
		const src = shape.src
		const fragment = this.fragment

		if (src?.format !== "odp" || fragment === undefined) return undefined
		if (src.part !== fragment.part || src.fragment !== fragment.offset || src.epoch !== fragment.epoch) return undefined
		if (src.node <= 0 || src.node >= fragment.document.count) return undefined

		return src.node
	}

	// The element a shape's markup stands for in its parent: its draw:a wrapper when it has one.
	outerNode(node: number): number {
		const fragment = this.fragment as Fragment
		const parent = fragment.document.parent(node)

		return parent > 0 && fragment.name(parent) === "draw:a" ? parent : node
	}

	// One shape's markup under the mapping `m` of its groups. `aspects` overrides what changed (a direct emit).
	element(shape: ShapeNode, m: Affine, aspects?: Aspects, force = false): EmitPiece[] | Refused {
		const pieces = this.shapeElement(shape, m, aspects, force)

		if (
			isRefused(pieces) ||
			shape.lock === undefined ||
			shape.synthetic === true ||
			textScaleOf(this.context.deck) === 1 ||
			!holdsText(shape)
		)
			return pieces

		// A shape kept as written holds its text at the text scale the content took through scaled copies of its styles.
		const fragment = this.fragment

		return pieces.map(piece => {
			const markup =
				typeof piece === "string"
					? piece
					: piece instanceof Uint8Array
						? decodeUtf8(piece)
						: fragment === undefined
							? undefined
							: decodeUtf8(fragment.document.raw(piece.hole))

			if (markup === undefined) return piece

			const scaled = odpKeptTextMarkup(markup, this.context.deck, this.styles, this.keptNames)

			return scaled === markup ? piece : scaled
		})
	}

	private shapeElement(shape: ShapeNode, m: Affine, aspects?: Aspects, force = false): EmitPiece[] | Refused {
		if (shape.synthetic === true) return []

		const node = this.sourceNode(shape)
		const aspectsHeld = aspects ?? this.aspectsOf(shape) ?? {}
		// A shape kept as written never has its text written from the model: a scaled change scales the model's copy
		// and the kept markup follows through scaled copies of its styles (element).
		const own = shape.lock !== undefined && shape.synthetic !== true ? { ...aspectsHeld, text: false } : aspectsHeld
		const moved = !isIdentity(m)

		if (node === undefined) {
			// A shape whose source is another fragment (held markup an undo read back, another page): written from there,
			// its spans copied as bytes.
			const foreign = shape.src === undefined ? undefined : this.styles.env.sourceFragment(shape.src)

			if (foreign === undefined || foreign === this.fragment) return this.whole(shape, m)

			const pieces = new OdpShapeWriter(this.context, foreign, this.slide, this.aspectsOf).element(shape, m, aspects, force)

			if (isRefused(pieces)) return pieces

			const out = pieces.map(piece => (typeof piece === "object" && "hole" in piece ? foreign.document.raw(piece.hole) : piece))
			const first = out[0]

			// Held markup carries the declarations in scope where it was on its start tag (to be read on its own): those in
			// scope here again come off, so the element is written as it was.
			if (first !== undefined && this.fragment !== undefined && typeof first !== "object") {
				const scope = this.landingScope()
				const kept = inScope(encodeUtf8(first), scope)

				out[0] = decodeUtf8(kept)
			} else if (first instanceof Uint8Array && this.fragment !== undefined) {
				out[0] = inScope(first, this.landingScope())
			}

			return out
		}

		// Content a family of its own writes (a table's cells; a picture's image, crop and adjustments): that family writes
		// the element, patching the frame through this writer for the rest.
		if (own.frame === true || (own.fill === true && shape.kind === "pic")) {
			const request: EmitRequest = {
				slide: this.slide,
				shape,
				touch: { kind: "shape", slide: this.slide.ref, shape: shape.id, dirt: { kind: "node" } }
			}
			const family = this.styles.env.familyOf(request)

			if (family === "table" || family === "picture" || family === "chart") {
				if (moved) return refused("unsupported", `a ${family} moved with its group`)

				const markup = markupOf(this.styles.env.dispatch(family, request, this.context))

				return isRefused(markup) ? markup : [this.withTargetId(shape, markup)]
			}
		}

		const changed = hasAspects(own) || moved || force

		if (!changed && (shape.kind !== "grpSp" || !this.membersChanged(shape))) return [{ hole: this.outerNode(node) }]

		return this.patch(shape, node, m, moved ? { ...own, xfrm: true } : own)
	}

	// Whether a group's members (or their order) differ from its source.
	private membersChanged(group: ShapeNode): boolean {
		const fragment = this.fragment as Fragment
		const node = this.sourceNode(group)

		if (node === undefined) return true

		const source: number[] = []

		for (let child = fragment.document.firstChildElement(node); child >= 0; child = fragment.document.nextSiblingElement(child))
			source.push(child)

		const members = group.children ?? []
		const nodes = members.map(member => this.sourceNode(member))
		const outer = nodes.map(at => (at === undefined ? -1 : this.outerNode(at)))
		const shapeChildren = source.filter(child => isShapeElement(fragment.name(child)))

		if (outer.length !== shapeChildren.length || outer.some((at, k) => at !== shapeChildren[k])) return true

		return members.some(member => hasAspects(this.aspectsOf(member)) || (member.kind === "grpSp" && this.membersChanged(member)))
	}

	// --- A source element patched. ---

	private patch(shape: ShapeNode, node: number, m: Affine, aspects: Aspects): EmitPiece[] | Refused {
		const fragment = this.fragment as Fragment
		const document = fragment.document
		const name = fragment.name(node)
		const changes: AttributeChange[] = []
		const replaced = new Map<string, string | null>()
		let textMarkup: string | undefined

		if (aspects.name === true) changes.push({ name: "draw:name", value: shape.name === "" ? null : shape.name })
		if (aspects.hidden === true) changes.push({ name: "draw:display", value: shape.hidden ? "none" : null })

		// A member moved into a new group carries xml:id beside its draw:id (ODF 1.3 Part 3 §19.130: draw:id is kept
		// for compatibility and, when present, xml:id shall be too, with the same value).
		const ids = fragment.attributes(node)
		const drawId = ids.get("draw:id")

		if (this.grouping && drawId !== undefined && !ids.has("xml:id")) changes.push({ name: "xml:id", value: drawId })

		// The id the save gives an animated shape without one (OdpEmitContext.targetIds) goes into its rewritten tag.
		const target = this.context.targetIds?.get(shape.id)

		if (target !== undefined && !ids.has("xml:id") && !ids.has("draw:id"))
			changes.push({ name: "xml:id", value: target }, { name: "draw:id", value: target })

		if (aspects.xfrm === true && name !== "draw:g") {
			const box = this.boxChanges(shape, name, m, fragment.attributes(node), aspects.pristine?.xfrm)

			if (isRefused(box)) return box

			appendAll(changes, this.lengthSpellings(shape, changedLengths(box, fragment.attributes(node)), fragment.attributes(node)))
		}

		// The box the element holds: the shape's own placed by the groups it moved with (a mirrored group mirrors it).
		const box = shape.xfrm === undefined ? undefined : placed(shape.xfrm, m)
		// A picture holds its flips as its graphic style's style:mirror (ODF 1.3 Part 3 §20.355), as canonicalBox says.
		const before = aspects.pristine?.xfrm === undefined ? undefined : canonicalBox(shape, aspects.pristine.xfrm)
		const held = box === undefined ? undefined : canonicalBox(shape, box)
		const mirror =
			shape.kind === "pic" && aspects.xfrm === true && held !== undefined && held.flipH !== (before?.flipH ?? false)
				? this.mirrorSpelling(shape, "style:mirror", this.ownMirror(node), pictureMirror(held), held.flipH)
				: undefined
		// A presentation object is a placeholder exactly while it is a prompt (LibreOffice writes the flag on one without
		// text; read/shapes.ts draws none of its fill, line or shadow): text, or a drawing given to it, takes the flag off,
		// and taking them back out puts it back.
		let styleAspects = aspects

		if (aspects.text === true || aspects.fill === true || aspects.ln === true || aspects.effects === true) {
			const own = fragment.attributes(node)
			const flagged = own.get("presentation:placeholder") === "true"
			const prompt = isPrompt(shape)

			if (flagged && !prompt) {
				changes.push({ name: "presentation:placeholder", value: null })
				// A drawing given to it: its style's others (none of which the prompt showed) written as the model has them.
				// Text alone leaves its style's drawing to show, as LibreOffice draws a presentation object holding text.
				if (aspects.fill === true || aspects.ln === true || aspects.effects === true)
					styleAspects = { ...aspects, fill: true, ln: true, effects: true }
			} else if (!flagged && own.has("presentation:class") && prompt)
				changes.push({ name: "presentation:placeholder", value: "true" })
		}

		const style = this.styleChange(shape, node, styleAspects, mirror)

		if (isRefused(style)) return style
		if (style !== undefined) changes.push(style)

		const outline = aspects.geometry === true ? "rewrite" : this.boxOutline(shape, node, name, aspects, box)
		let mirrors: AttributeChange[] | undefined

		if (outline === "rewrite") {
			const geometry = this.geometryChange(shape, name, box)

			if (isRefused(geometry)) return geometry

			appendAll(changes, geometry.attributes)
			if (geometry.enhanced !== undefined) replaced.set("draw:enhanced-geometry", geometry.enhanced)
		} else mirrors = outline

		if (aspects.text === true) {
			const text = this.text(shape)

			if (isRefused(text)) return text

			textMarkup = text
		}

		if (aspects.alt === true) {
			replaced.set(
				"svg:title",
				shape.alt?.title === undefined || shape.alt.title === "" ? null : `<svg:title>${escapeText(shape.alt.title)}</svg:title>`
			)
			replaced.set(
				"svg:desc",
				shape.alt?.descr === undefined || shape.alt.descr === "" ? null : `<svg:desc>${escapeText(shape.alt.descr)}</svg:desc>`
			)
		}

		let wrapper: string | null | undefined

		if (aspects.actions === true) {
			const action = this.actionChange(shape, node)

			if (isRefused(action)) return action

			replaced.set("office:event-listeners", action.listeners)
			wrapper = action.wrapper
		}

		const pieces: EmitPiece[] = []
		const outer = this.outerNode(node)
		const wrapped = outer !== node

		if (wrapped && wrapper !== null) {
			const href = wrapper === undefined ? undefined : [{ name: "xlink:href", value: wrapper }]

			pieces.push(this.startTag(outer, href ?? [], false))
		}

		const children = this.children(shape, node, name, m, replaced, textMarkup, mirrors)

		if (isRefused(children)) return children

		// An element the source closes on its own start tag, still empty, is written so again.
		if (children.length === 0 && document.isSelfClosing(node)) pieces.push(this.startTag(node, changes, true))
		else pieces.push(this.startTag(node, changes, false), ...children, `</${document.name(node)}>`)

		if (wrapped && wrapper !== null) pieces.push(`</${document.name(outer)}>`)

		return pieces
	}

	// The element's start tag with attribute changes (and the namespace declarations new attributes need).
	private startTag(node: number, changes: readonly AttributeChange[], selfClose: boolean): string {
		const fragment = this.fragment as Fragment
		const document = fragment.document
		const wanted = new Map<string, string | null>()
		const declarations = new Map<string, string>()

		for (const change of changes) {
			const colon = change.name.indexOf(":")
			const prefix = change.name.slice(0, colon)
			const uri = WRITTEN_NAMESPACES[prefix]
			let actual = uri === undefined ? undefined : fragment.namespaces.prefixFor(node, uri)

			if (actual === undefined && uri !== undefined) {
				actual = prefix
				declarations.set(prefix, uri)
			}

			wanted.set(`${actual ?? prefix}:${change.name.slice(colon + 1)}`, change.value)
		}

		let out = `<${document.name(node)}`
		// A box attribute the element lacks goes where LibreOffice writes it, before the first of the box's later ones the
		// element has (svg:x and svg:y back before svg:width, as they were before a turn took them out).
		const present = new Set(document.attributes(node).map(attribute => attribute.name))
		const placeBefore = (name: string): void => {
			const at = BOX_ORDER.indexOf(name)

			if (at < 0) return

			for (const qualified of BOX_ORDER.slice(0, at)) {
				const value = wanted.get(qualified)

				if (present.has(qualified) || value === undefined) continue

				wanted.delete(qualified)

				if (value !== null) out += ` ${qualified}="${escapeAttribute(value)}"`
			}
		}

		for (const attribute of document.attributes(node)) {
			placeBefore(attribute.name)

			if (wanted.has(attribute.name)) {
				const value = wanted.get(attribute.name)

				wanted.delete(attribute.name)

				if (value === null || value === undefined) continue

				out += ` ${attribute.name}="${escapeAttribute(value)}"`

				continue
			}

			out += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
		}

		for (const [prefix, uri] of declarations) out += ` xmlns:${prefix}="${escapeAttribute(uri)}"`
		for (const [qualified, value] of wanted) if (value !== null) out += ` ${qualified}="${escapeAttribute(value)}"`

		return `${out}${selfClose ? "/>" : ">"}`
	}

	// The element's content: children copied by span, replaced or taken out, text placed, members of a group written.
	private children(
		shape: ShapeNode,
		node: number,
		name: string,
		m: Affine,
		replaced: Map<string, string | null>,
		text: string | undefined,
		mirrors?: readonly AttributeChange[]
	): EmitPiece[] | Refused {
		const fragment = this.fragment as Fragment
		const document = fragment.document
		const out: EmitPiece[] = []
		const done = new Set<string>()
		const frame = name === "draw:frame"
		let textPlaced = text === undefined
		const placeText = (): void => {
			if (!textPlaced && text !== undefined) out.push(text)
			textPlaced = true
		}
		// Replacements the element does not have yet, placed where the schema puts them.
		const insertMissing = (names: readonly string[]): void => {
			for (const missing of names) {
				const markup = replaced.get(missing)

				if (markup !== undefined && markup !== null && !done.has(missing)) {
					out.push(this.declared(markup, node))
					done.add(missing)
				}
			}
		}

		if (!frame) insertMissing(["svg:title", "svg:desc", "office:event-listeners"])

		if (name === "draw:g") {
			const members = this.members(shape, m)

			if (isRefused(members)) return members

			let membersPlaced = false

			for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
				const childName = document.kind(child) === NodeKind.Element ? fragment.name(child) : ""

				if (isShapeElement(childName)) {
					if (!membersPlaced) appendAll(out, members)
					membersPlaced = true

					continue
				}

				const kept = this.keep(child, childName, replaced, done)

				if (kept !== undefined) out.push(kept)
			}

			if (!membersPlaced) appendAll(out, members)

			return out
		}

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)
			const childName = kind === NodeKind.Element ? fragment.name(child) : ""

			if (frame && childName === "draw:text-box" && text !== undefined && !textPlaced) {
				out.push(
					...(text === ""
						? [this.startTag(child, [], true)]
						: [this.startTag(child, [], false), text, `</${document.name(child)}>`])
				)
				textPlaced = true

				continue
			}

			if (!frame && TEXT_ELEMENTS.has(childName) && text !== undefined) {
				placeText()

				continue
			}

			if (!frame && childName === "draw:enhanced-geometry") placeText()
			if (
				frame &&
				(childName === "svg:title" ||
					childName === "svg:desc" ||
					childName === "draw:contour-polygon" ||
					childName === "draw:contour-path")
			)
				insertMissing(["office:event-listeners"])
			if (frame && (childName === "draw:contour-polygon" || childName === "draw:contour-path"))
				insertMissing(["svg:title", "svg:desc"])

			// A shape the box turned over keeps its outline (type, modifiers, formulas and handles), its mirrors changed.
			if (childName === "draw:enhanced-geometry" && mirrors !== undefined && mirrors.length > 0 && !replaced.has(childName)) {
				const empty = document.firstChild(child) < 0

				out.push(this.startTag(child, mirrors, empty))

				if (!empty) {
					for (let inner = document.firstChild(child); inner >= 0; inner = document.nextSibling(inner)) out.push({ hole: inner })

					out.push(`</${document.name(child)}>`)
				}

				continue
			}

			const kept = this.keep(child, childName, replaced, done)

			if (kept !== undefined) out.push(kept)
		}

		if (frame && text !== undefined && !textPlaced) return refused("unsupported", "text on a frame without a text box")

		if (frame) insertMissing(["office:event-listeners", "svg:title", "svg:desc"])

		placeText()

		const enhanced = replaced.get("draw:enhanced-geometry")

		if (enhanced !== undefined && enhanced !== null && !done.has("draw:enhanced-geometry")) out.push(this.declared(enhanced, node))

		return out
	}

	// A child kept as its source (a hole), replaced, or dropped.
	private keep(child: number, childName: string, replaced: Map<string, string | null>, done: Set<string>): EmitPiece | undefined {
		if (!replaced.has(childName)) return { hole: child }
		if (done.has(childName)) return undefined

		done.add(childName)

		const markup = replaced.get(childName)

		return markup === null || markup === undefined ? undefined : this.declared(markup, child)
	}

	// New markup with the declarations its prefixes need where it goes (`at`: an element in the same scope).
	private declared(markup: string, at: number): string {
		const fragment = this.fragment

		return fragment === undefined ? markup : declared(markup, fragment.namespaces.inScope(at))
	}

	// A group's members under the group's mapping.
	private members(group: ShapeNode, m: Affine): EmitPiece[] | Refused {
		const now = groupAffine(group.xfrm)

		if (isRefused(now)) return now

		// The members' own boxes are in the group's space (a group read from ODP maps it onto itself: its box is its
		// members' bounds).
		const mapping = compose(m, now)
		const out: EmitPiece[] = []

		for (const member of group.children ?? []) {
			const pieces = this.element(member, mapping)

			if (isRefused(pieces)) return pieces

			appendAll(out, pieces)
		}

		return out
	}

	// --- Box. ---

	private boxChanges(
		shape: ShapeNode,
		name: string,
		m: Affine,
		attributes: ReadonlyMap<string, string>,
		pristine?: Xfrm
	): AttributeChange[] | Refused {
		const xfrm = shape.xfrm

		if (xfrm === undefined) return []

		if (LINES.has(name)) {
			if (attributes.has("svg:d")) return refused("unsupported", "a routed connector moved")

			const [x1, y1, x2, y2] = lineEnds(xfrm, m)

			return [
				{ name: "svg:x1", value: cm(x1) },
				{ name: "svg:y1", value: cm(y1) },
				{ name: "svg:x2", value: cm(x2) },
				{ name: "svg:y2", value: cm(y2) },
				{ name: "draw:transform", value: null }
			]
		}

		if (!BOXED.has(name)) return refused("unsupported", `the box of ${name}`)

		// An element without a mirror of its own holds its box as DrawingML means the flips (canonicalBox); a polygon,
		// polyline or path that stays mirrored holds the mirror in its draw:transform.
		const box = name === "draw:custom-shape" ? placed(xfrm, m) : canonicalBox(shape, placed(xfrm, m))

		if ((box.flipH || box.flipV) && name !== "draw:custom-shape" && shape.kind !== "pic") {
			if (!MIRRORED_BY_TRANSFORM.has(name)) return refused("unsupported", `a mirrored ${name}`)

			const out = mirroredBoxAttributes(box)

			if (attributes.has("presentation:class")) out.push({ name: "presentation:user-transformed", value: "true" })

			return out
		}

		// A custom shape's draw:mirror-* (one of them for an ODF trapezoid that is no mirror in DrawingML).
		const geometry = shape.props?.geometry
		let trapezoid = false

		if (name === "draw:custom-shape" && geometry?.kind === "preset" && geometry.preset === "trapezoid") {
			const fragment = this.fragment as Fragment

			for (
				let child = fragment.document.firstChildElement(this.sourceNode(shape) ?? -1);
				child >= 0;
				child = fragment.document.nextSiblingElement(child)
			) {
				const enhanced = fragment.name(child) === "draw:enhanced-geometry" ? fragment.attributes(child) : undefined

				if (enhanced?.get("draw:type") === "trapezoid" && !enhanced.has("draw:enhanced-path"))
					trapezoid =
						odfPresetAttributes("trapezoid", geometry.guides, box)?.find(([key]) => key === "draw:type")?.[1] === "trapezoid"
			}
		}

		const out = boxAttributes(name === "draw:custom-shape" ? mirrorTurn(box, trapezoid) : box)

		// A presentation object a save moves is marked user-transformed (ODF 1.3 Part 3 §19.415: LibreOffice then keeps it
		// off its layout's box). The box it had is kept for the session: moved back there (an undo), the mark goes again.
		if (attributes.has("presentation:class")) {
			const boxes = this.styles.env.placeholderBoxes
			const key = `${String(this.slide.ref)}\u0000${String(shape.id)}`
			const near = (a: Xfrm, b: Xfrm): boolean =>
				Math.abs(a.x - b.x) <= 1 &&
				Math.abs(a.y - b.y) <= 1 &&
				Math.abs(a.cx - b.cx) <= 1 &&
				Math.abs(a.cy - b.cy) <= 1 &&
				a.rot === b.rot
			const original = boxes?.get(key)

			if (attributes.get("presentation:user-transformed") === "true") {
				if (original !== undefined && near(original, box)) {
					out.push({ name: "presentation:user-transformed", value: null })
					boxes?.delete(key)
				}
			} else if (pristine === undefined || !near(pristine, box)) {
				// The source's box, on its page (an ODP group's members are placed in page space).
				out.push({ name: "presentation:user-transformed", value: "true" })

				if (pristine !== undefined) boxes?.set(key, pristine)
			}
		}

		return out
	}

	// --- Style. ---

	private styleChange(shape: ShapeNode, node: number, aspects: Aspects, mirror?: string | null): AttributeChange | Refused | undefined {
		const groups = (["fill", "ln", "effects", "bodyPr"] as const).filter(group => aspects[group] === true)

		if (groups.length === 0 && aspects.text !== true && mirror === undefined) return undefined

		const changes = styleChanges()

		if (mirror !== undefined) setProperty(changes, "graphic", "style:mirror", mirror)
		const props = shape.props ?? {}
		const frame = (this.fragment as Fragment).name(node) === "draw:frame"

		for (const group of groups) {
			const failed =
				group === "fill"
					? this.fillAgain(shape, node, aspects, changes)
					: group === "ln"
						? lineChanges(changes, props.ln, aspects.pristine?.props?.ln)
						: group === "effects"
							? effectChanges(changes, props.effects)
							: bodyChanges(changes, props.bodyPr ?? {}, frame)

			if (failed !== undefined) return failed
		}

		// A body's text area travels with its text (text.bodyPr is what the shape's style says).
		if (aspects.text === true && aspects.bodyPr !== true && shape.text !== undefined) {
			const before = aspects.pristine?.text?.bodyPr

			if (before === undefined || JSON.stringify(before) !== JSON.stringify(shape.text.bodyPr)) {
				const failed = bodyChanges(changes, shape.text.bodyPr, frame)

				if (failed !== undefined) return failed
			}
		}

		const fragment = this.fragment as Fragment
		const attributes = fragment.attributes(node)
		const presentation = attributes.get("presentation:style-name")
		const graphic = attributes.get("draw:style-name")

		// The style's own text sizes at the text scale the content took (a scaled slide size change, emit/design.ts).
		if (aspects.text === true)
			odpScaledTextChanges(
				changes,
				this.context.deck,
				presentation !== undefined
					? this.styles.style("presentation", presentation)
					: graphic === undefined
						? undefined
						: this.styles.style("graphic", graphic)
			)

		if (changes.attributes.size === 0 && changes.children.size === 0) return undefined

		if (presentation !== undefined)
			return { name: "presentation:style-name", value: this.styles.derived("presentation", presentation, changes) }

		return { name: "draw:style-name", value: this.styles.derived("graphic", graphic, changes) }
	}

	// A box's length changes, each written as the file first wrote it when it comes back to that length (its unit and
	// spelling, "0in" or "-0in", kept for the session from the first save that changed it), so a box moved back is
	// written as its source was.
	private lengthSpellings(shape: ShapeNode, changes: AttributeChange[], attributes: ReadonlyMap<string, string>): AttributeChange[] {
		const values = this.styles.env.mirrorValues

		if (values === undefined) return changes

		return changes.map(change => {
			if (change.value === null || !LENGTHS.has(change.name)) return change

			const key = `${String(this.slide.ref)}\u0000${String(shape.id)}\u0000${change.name}`

			if (!values.has(key)) values.set(key, attributes.get(change.name))

			const original = values.get(key)

			return original !== undefined && emuOf(original) === emuOf(change.value) ? { name: change.name, value: original } : change
		})
	}

	// A shape's fill. One back to the fill its source style held when a save first changed it (an undo across that save)
	// is that style's own fill attributes again, kept for the session: the file's spelling, and a gradient, hatch or
	// bitmap the style writer cannot make (each names a drawing resource) written at all. Any other fill is written new.
	private fillAgain(shape: ShapeNode, node: number, aspects: Aspects, changes: StyleChanges): Refused | undefined {
		const fill = shape.props?.fill
		const values = this.styles.env.mirrorValues
		const key = `${String(this.slide.ref)}\u0000${String(shape.id)}\u0000fill`

		if (values !== undefined && !values.has(key) && aspects.pristine !== undefined) {
			const attributes = (this.fragment as Fragment).attributes(node)
			const presentation = attributes.get("presentation:style-name")
			const name = presentation ?? attributes.get("draw:style-name")
			const own = name === undefined ? undefined : this.styles.style(presentation === undefined ? "graphic" : "presentation", name)
			const graphic = own?.properties.get("graphic")?.attributes

			values.set(
				key,
				JSON.stringify({
					fill: aspects.pristine.props?.fill ?? null,
					attributes: FILL_ATTRIBUTES.map(each => [each, graphic?.get(each) ?? null])
				})
			)
		}

		const held = values?.get(key)
		const kept = held === undefined ? undefined : (JSON.parse(held) as { fill: unknown; attributes: [string, string | null][] })

		if (kept === undefined || JSON.stringify(kept.fill) !== JSON.stringify(fill ?? null)) return fillChanges(changes, fill)

		for (const [name, value] of kept.attributes) setProperty(changes, "graphic", name, value)

		return undefined
	}

	// The declarations in force where this writer's shapes land: its page's or notes element's (the notes of a page may
	// bind prefixes of their own, as LibreOffice writes office:forms there).
	private landingScope(): ReadonlyMap<string, string> {
		const fragment = this.fragment as Fragment
		const src = this.slide.src
		const node =
			src?.format === "odp" && src.part === fragment.part && src.fragment === fragment.offset && src.epoch === fragment.epoch
				? src.node
				: -1
		const root = rootScope(fragment.document)

		if (node <= 0 || node >= fragment.document.count) return root

		const own = fragment.namespaces.inScope(node)

		return own.size === 0 ? root : new Map([...root, ...own])
	}

	// --- Geometry. ---
	// The value a mirror attribute is written with (`fresh` for one turned on): the file's own value when the mirror goes
	// back to what the file had (its spelling, draw:mirror-horizontal="false" or style:mirror="none", or none), kept for
	// the session from the first save that changed it.
	private mirrorSpelling(
		shape: ShapeNode,
		name: string,
		current: string | undefined,
		fresh: string | undefined,
		on: boolean
	): string | null {
		const values = this.styles.env.mirrorValues
		const key = `${String(this.slide.ref)}\u0000${String(shape.id)}\u0000${name}`

		if (values !== undefined && !values.has(key)) values.set(key, current)

		const original = values === undefined ? current : values.get(key)
		const originalOn = name === "style:mirror" ? (original ?? "").includes("horizontal") : original === "true"

		if (on === originalOn) return original ?? null

		return fresh ?? null
	}

	// A picture's own style:mirror (its graphic style's), as the file writes it.
	private ownMirror(node: number): string | undefined {
		const name = (this.fragment as Fragment).attributes(node).get("draw:style-name")
		const style = name === undefined ? undefined : this.styles.style("graphic", name)

		return style?.properties.get("graphic")?.attributes.get("style:mirror")
	}

	// What a custom shape's new box does to its draw:enhanced-geometry: an outline evaluated for the box (ooxml-*, a
	// preset written from DrawingML) is written again when the size or a flip changes; any other (an ODF type with its
	// modifiers, a path with its formulas and handles) is kept, its mirrors turned as the flips changed (and a
	// trapezoid's inset kept on its new width).
	private boxOutline(
		shape: ShapeNode,
		node: number,
		name: string,
		aspects: Aspects,
		after: Xfrm | undefined
	): "rewrite" | AttributeChange[] | undefined {
		const before = aspects.pristine?.xfrm

		if (aspects.xfrm !== true || name !== "draw:custom-shape" || before === undefined || after === undefined) return undefined

		const fragment = this.fragment as Fragment
		const document = fragment.document
		let enhanced = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
			if (fragment.name(child) === "draw:enhanced-geometry") enhanced = child

		if (enhanced < 0) return undefined

		const attributes = fragment.attributes(enhanced)
		const geometry = shape.props?.geometry
		const turnedH = before.flipH !== after.flipH
		const turnedV = before.flipV !== after.flipV
		const resized = before.cx !== after.cx || before.cy !== after.cy

		// An outline of plain numbers is one evaluated for its box; LibreOffice's own ooxml-* outlines are formulas,
		// which follow any box.
		const evaluated = /^[A-Z0-9 .-]*$/u.test(attributes.get("draw:enhanced-path") ?? "?")

		if ((attributes.get("draw:type") ?? "").startsWith("ooxml-") && evaluated && geometry?.kind === "preset")
			return resized || turnedH || turnedV ? "rewrite" : undefined

		const changes: AttributeChange[] = []
		const mirror = (attribute: string, turned: boolean): void => {
			if (turned) {
				const on = attributes.get(attribute) !== "true"

				changes.push({
					name: attribute,
					value: this.mirrorSpelling(shape, attribute, attributes.get(attribute), on ? "true" : undefined, on)
				})
			}
		}

		// The new box is written without the source's draw:transform, so a mirror it held (read as a vertical flip)
		// moves to the outline.
		const matrix = transformMatrix(fragment.attributes(node).get("draw:transform") ?? "")
		const mirrored = matrix !== undefined && matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0

		mirror("draw:mirror-horizontal", turnedH)
		mirror("draw:mirror-vertical", turnedV !== mirrored)

		// ODF measures a trapezoid's inset on the width and DrawingML on the shorter side: its modifier follows the
		// box so the shape keeps the adjustment it has.
		if (resized && attributes.get("draw:type") === "trapezoid" && geometry?.kind === "preset" && geometry.preset === "trapezoid") {
			const outline = odfPresetAttributes("trapezoid", geometry.guides, after) ?? []
			const modifier = outline.find(([key]) => key === "draw:modifiers")?.[1]

			// An adjustment the type cannot hold on the new box is written as the evaluated outline.
			if (outline.find(([key]) => key === "draw:type")?.[1] !== "trapezoid") return "rewrite"
			if (modifier !== undefined) changes.push({ name: "draw:modifiers", value: modifier })
		}

		return changes
	}

	private geometryChange(
		shape: ShapeNode,
		name: string,
		box: Xfrm | undefined
	): { readonly attributes: AttributeChange[]; readonly enhanced?: string } | Refused {
		const geometry = shape.props?.geometry

		if (geometry === undefined) return refused("unsupported", "a geometry taken back to the inherited one")

		if (name === "draw:custom-shape") {
			// The new outline is the preset's: the old path, formulas and handles go.
			const enhanced = presetMarkup(geometry, box ?? this.inheritedBox(shape))

			return isRefused(enhanced) ? enhanced : { attributes: [], enhanced }
		}

		return refused("unsupported", `a new outline for ${name}`)
	}

	// --- Text. ---

	private text(shape: ShapeNode): string | Refused {
		const request: EmitRequest = {
			slide: this.slide,
			shape,
			touch: { kind: "shape", slide: this.slide.ref, shape: shape.id, dirt: { kind: "text" } }
		}
		const result = this.styles.env.dispatch("text", request, this.context)

		return markupOf(result)
	}

	// --- Click action. ---

	private actionChange(
		shape: ShapeNode,
		node: number
	): { readonly listeners: string | null; readonly wrapper: string | null | undefined } | Refused {
		if (shape.actions?.hover !== undefined) return refused("unsupported", "a hover action")

		const click = shape.actions?.click
		const wrapped = this.outerNode(node) !== node

		if (click === undefined) return { listeners: null, wrapper: wrapped ? null : undefined }

		const listener = listenerMarkup(click, this.styles)

		if (isRefused(listener)) return listener

		return { listeners: `<office:event-listeners>${listener}</office:event-listeners>`, wrapper: wrapped ? null : undefined }
	}

	// --- A shape written whole. ---

	private whole(shape: ShapeNode, m: Affine): EmitPiece[] | Refused {
		const family = this.styles.env.familyOf({
			slide: this.slide,
			shape,
			touch: { kind: "shape", slide: this.slide.ref, shape: shape.id, dirt: { kind: "node" } }
		})

		if (family !== "shape") {
			const result = this.styles.env.dispatch(
				family,
				{ slide: this.slide, shape, touch: { kind: "shape", slide: this.slide.ref, shape: shape.id, dirt: { kind: "node" } } },
				this.context
			)
			const markup = markupOf(result)

			return isRefused(markup) ? markup : [this.withTargetId(shape, markup)]
		}

		const markup = this.newShape(shape, m)

		if (isRefused(markup)) return markup

		const fragment = this.fragment

		return [
			fragment === undefined
				? markup
				: declared(markup, fragment.namespaces.inScope(fragment.document.firstChildElement(fragment.document.documentElement())))
		]
	}

	private newShape(shape: ShapeNode, m: Affine): string | Refused {
		if (shape.lock !== undefined) return refused("locked", shape.lock)

		const common = this.commonAttributes(shape)

		if (isRefused(common)) return common

		const alt =
			(shape.alt?.title === undefined || shape.alt.title === "" ? "" : `<svg:title>${escapeText(shape.alt.title)}</svg:title>`) +
			(shape.alt?.descr === undefined || shape.alt.descr === "" ? "" : `<svg:desc>${escapeText(shape.alt.descr)}</svg:desc>`)
		let listeners = ""

		if (shape.actions?.hover !== undefined) return refused("unsupported", "a hover action")

		if (shape.actions?.click !== undefined) {
			const listener = listenerMarkup(shape.actions.click, this.styles)

			if (isRefused(listener)) return listener

			listeners = `<office:event-listeners>${listener}</office:event-listeners>`
		}

		switch (shape.kind) {
			case "grpSp": {
				const now = groupAffine(shape.xfrm)

				if (isRefused(now)) return now

				let members = ""

				for (const member of shape.children ?? []) {
					// A member moved into a new group whose start tag has a draw:id without its xml:id gets the xml:id
					// (patch() adds it) rather than its bytes copied as they were.
					const at = this.sourceNode(member)
					const attributes = at === undefined ? undefined : this.fragment?.attributes(at)
					const needsId = attributes?.has("draw:id") === true && !attributes.has("xml:id")
					const grouping = this.grouping

					this.grouping = needsId

					const pieces = needsId
						? this.element(member, compose(m, now), this.aspectsOf(member) ?? {}, true)
						: this.element(member, compose(m, now))

					this.grouping = grouping

					if (isRefused(pieces)) return pieces

					for (const piece of pieces) {
						if (typeof piece === "string") members += piece
						else if (piece instanceof Uint8Array) members += decodeUtf8(piece, 0, piece.length)
						else if (this.fragment !== undefined) {
							const raw = this.fragment.document.raw(piece.hole)

							members += decodeUtf8(raw, 0, raw.length)
						} else return refused("failed", "a group member copied without its source")
					}
				}

				return `<draw:g${common}>${alt}${listeners}${members}</draw:g>`
			}
			case "cxnSp": {
				const geometry = shape.props?.geometry

				if (shape.xfrm === undefined || (geometry !== undefined && (geometry.kind !== "preset" || geometry.preset !== "line")))
					return refused("unsupported", "a connector other than a straight line")

				const [x1, y1, x2, y2] = lineEnds(shape.xfrm, m)
				const style = this.newStyle(shape)

				if (isRefused(style)) return style

				return `<draw:line${common}${style} svg:x1="${cm(x1)}" svg:y1="${cm(y1)}" svg:x2="${cm(x2)}" svg:y2="${cm(y2)}">${alt}${listeners}<text:p/></draw:line>`
			}
			case "sp":
				return this.newSp(shape, m, common, alt, listeners)
			default:
				return refused("unsupported", `a new ${shape.kind}`)
		}
	}

	private newSp(shape: ShapeNode, m: Affine, common: string, alt: string, listeners: string): string | Refused {
		const geometry = shape.props?.geometry
		const xfrm = shape.xfrm ?? this.inheritedBox(shape)

		if (xfrm === undefined) return refused("unsupported", "a new shape without a box")

		const box = placed(xfrm, m)
		const markupOf = (held: Xfrm): string =>
			boxAttributes(held)
				.filter(change => change.value !== null)
				.map(change => ` ${change.name}="${escapeAttribute(change.value as string)}"`)
				.join("")
		const boxMarkup = markupOf(box)
		const text = shape.text === undefined ? "" : this.text(shape)

		if (isRefused(text)) return text

		const placeholder = shape.ph === undefined ? undefined : CLASS_OF[shape.ph.type]
		const rectangle =
			geometry === undefined || (geometry.kind === "preset" && geometry.preset === "rect" && geometry.guides.length === 0)
		// A shape that fits its text (a:spAutoFit, §21.1.2.1.4) grows and shrinks to it: a text frame's height is its
		// least in LibreOffice 7.5 (measured: a frame keeps svg:height, a custom shape takes its text's), so such a
		// rectangle outside the placeholders is a custom shape.
		const fits = (shape.props?.bodyPr?.autofit ?? shape.text?.bodyPr.autofit) === "shape"
		const isTextFrame = rectangle && (placeholder !== undefined || !fits)

		if (isTextFrame && !box.flipH && !box.flipV) {
			const style = placeholder === undefined ? this.newStyle(shape, true) : this.newPresentationStyle(shape, placeholder)

			if (isRefused(style)) return style

			const classes =
				placeholder === undefined
					? ""
					: ` presentation:class="${placeholder}"${isPrompt(shape) ? ' presentation:placeholder="true"' : ""} presentation:user-transformed="true"`

			return `<draw:frame${common}${style}${classes}${boxMarkup}><draw:text-box>${text}</draw:text-box>${listeners}${alt}</draw:frame>`
		}

		if (placeholder !== undefined) return refused("unsupported", "a placeholder with an outline")

		const enhanced = rectangle
			? presetMarkup({ kind: "preset", preset: "rect", guides: [] }, box)
			: geometry === undefined
				? refused("unsupported", "a new shape without an outline")
				: presetMarkup(geometry, box)

		if (isRefused(enhanced)) return enhanced

		const style = this.newStyle(shape)

		if (isRefused(style)) return style

		// The turn as LibreOffice reads it under the outline's mirrors (mirrorTurn).
		const mirrored = (attribute: string): boolean => enhanced.includes(` ${attribute}="true"`)
		const turned = mirrored("draw:mirror-horizontal") !== mirrored("draw:mirror-vertical") && box.rot !== 0
		const held = turned ? markupOf({ ...box, rot: (21_600_000 - box.rot) % 21_600_000 }) : boxMarkup

		return `<draw:custom-shape${common}${style}${held}>${alt}${listeners}${text}${enhanced}</draw:custom-shape>`
	}

	// The box a new placeholder takes from its layout or master (the model leaves it to inheritance): written, so the
	// file shows it where the editor did.
	private inheritedBox(shape: ShapeNode): Xfrm | undefined {
		const ph = shape.ph

		if (ph === undefined) return undefined

		const deck = this.context.deck
		const layout = this.slide.parent === undefined ? undefined : deck.nodes.get(this.slide.parent)
		const master = layout?.parent === undefined ? undefined : deck.nodes.get(layout.parent)
		// The layout's placeholder (an ODF presentation:presentation-page-layout's), else the master's of that kind (a
		// deck without page layouts places its placeholders by the master's presentation objects, ODF 1.3 Part 3
		// §10.2.4 presentation:class).
		const kind = (type: string | undefined): string => (type === "ctrTitle" ? "title" : type === "obj" ? "body" : (type ?? "body"))
		const find = (shapes: readonly ShapeNode[] | undefined): Xfrm | undefined =>
			(
				shapes?.find(candidate => candidate.ph?.type === ph.type && candidate.ph.idx === ph.idx && candidate.xfrm !== undefined) ??
				shapes?.find(
					candidate => candidate.ph !== undefined && kind(candidate.ph.type) === kind(ph.type) && candidate.xfrm !== undefined
				)
			)?.xfrm

		return find(layout?.shapes) ?? find(master?.shapes)
	}

	// The id a new element the slide's timing animates is named by: the one the save gave it (OdpEmitContext.targetIds,
	// unique in the document), else its target id (core/anim/odf.ts odpTargetId).
	private targetIdOf(shape: ShapeNode): string | undefined {
		this.targets ??= odpTargetIds(this.slide.timing)

		if (!this.targets.has(shape.id)) return undefined

		return this.context.targetIds?.get(shape.id) ?? odpTargetId(shape, this.fragment, this.idPrefix)
	}

	// A frame another family wrote whole (a picture, table, chart, medium): its start tag named by the id the slide's
	// timing targets it by, unless the markup carries an id of its own.
	private withTargetId(shape: ShapeNode, markup: string): string {
		const target = this.targetIdOf(shape)
		const tag = START_TAG.exec(markup)

		if (target === undefined || tag === null || /\s(?:xml|draw):id\s*=/u.test(tag[0])) return markup

		const at = (tag[1] ?? "").length

		return `${markup.slice(0, at)} xml:id="${escapeAttribute(target)}" draw:id="${escapeAttribute(target)}"${markup.slice(at)}`
	}

	private commonAttributes(shape: ShapeNode): string | Refused {
		let out = ""

		if (shape.name !== "") out += ` draw:name="${escapeAttribute(shape.name)}"`

		const target = this.targetIdOf(shape)

		if (target !== undefined) out += ` xml:id="${escapeAttribute(target)}" draw:id="${escapeAttribute(target)}"`
		if (shape.hidden) out += ' draw:display="none"'

		return out
	}

	// A new shape's graphic style: its fill, line, shadow and text area.
	private newStyle(shape: ShapeNode, frame = false): string | Refused {
		const changes = this.propsChanges(shape, frame)

		if (isRefused(changes)) return changes
		if (changes.attributes.size === 0 && changes.children.size === 0) return ""

		return ` draw:style-name="${escapeAttribute(this.styles.derived("graphic", undefined, changes))}"`
	}

	// A new placeholder's presentation style: its master's for its class, with what the shape says over it.
	private newPresentationStyle(shape: ShapeNode, placeholder: string): string | Refused {
		const changes = this.propsChanges(shape, true)

		if (isRefused(changes)) return changes

		const master = this.masterName()
		const suffix = STYLE_SUFFIX[placeholder]
		const base = master === undefined || suffix === undefined ? undefined : `${master}-${suffix}`
		const known = base !== undefined && this.styles.sheet.style("presentation", base, "styles") !== undefined

		if (changes.attributes.size === 0 && changes.children.size === 0)
			return known ? ` presentation:style-name="${escapeAttribute(base)}"` : ""

		return ` presentation:style-name="${escapeAttribute(this.styles.derived("presentation", known ? base : undefined, changes))}"`
	}

	private masterName(): string | undefined {
		const deck = this.context.deck
		const layout = this.slide.parent === undefined ? undefined : deck.nodes.get(this.slide.parent)
		const master = layout?.parent === undefined ? undefined : deck.nodes.get(layout.parent)

		return master?.name
	}

	// `frame`: the style is a text frame's (draw:frame), which writes its wrap as draw:auto-grow-width (bodyChanges).
	private propsChanges(shape: ShapeNode, frame = false): StyleChanges | Refused {
		const changes = styleChanges()
		const props = shape.props

		const resources = this.styles.resources

		if (props?.fill !== undefined) {
			const written = resources !== undefined && props.fill !== "none" && resourceFillChanges(changes, props.fill, resources)
			const failed = written ? undefined : fillChanges(changes, props.fill)

			if (failed !== undefined) return failed
		}

		if (props?.ln !== undefined) {
			// Dashes and ends are drawing resources: written as such where the package's styles take new ones.
			const ln = props.ln
			const {
				dash: _dash,
				custDash: _custDash,
				head: _head,
				tail: _tail,
				...plain
			} = ln === "none" ? { dash: undefined, custDash: undefined, head: undefined, tail: undefined } : ln
			const failed = lineChanges(changes, resources === undefined || ln === "none" ? ln : plain, undefined)

			if (failed !== undefined) return failed
			if (resources !== undefined && ln !== "none") resourceLineChanges(changes, ln, resources)
		}

		if (props?.effects !== undefined) {
			const failed = effectChanges(changes, props.effects)

			if (failed !== undefined) return failed
		}

		const body = props?.bodyPr ?? shape.text?.bodyPr

		if (body !== undefined) {
			const failed = bodyChanges(changes, body, frame)

			if (failed !== undefined) return failed
		}

		// LibreOffice 7.5 lays a shape's text out by its graphic style's line-spacing rule, not its paragraphs' (measured:
		// paragraphs saying font-independent under a style that does not keep the face's line heights).
		const paragraphs = shape.text?.paragraphs ?? []

		if (paragraphs.length > 0 && paragraphs.every(paragraph => paragraph.pPr.fontIndependentLineSpacing === true))
			setProperty(changes, "paragraph", "style:font-independent-line-spacing", "true")

		return changes
	}
}

// The box attributes in the order LibreOffice writes them.
const BOX_ORDER: readonly string[] = ["svg:x", "svg:y", "svg:width", "svg:height", "draw:transform"]

// The canonical names of elements that are shapes (members of a page or a group).
export function isShapeElement(name: string): boolean {
	return name === "draw:a" || BOXED.has(name) || LINES.has(name) || name === "draw:g" || name === "draw:page-thumbnail"
}

// Whether a shape holds text (LibreOffice's presentation:placeholder="true" is a placeholder without any).
function holdsText(shape: ShapeNode): boolean {
	return shape.text !== undefined || (shape.children ?? []).some(holdsText)
}

function hasText(shape: ShapeNode): boolean {
	return shape.text?.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "r" || run.text !== "")) ?? false
}

// Whether a presentation object is a prompt (presentation:placeholder="true"): no text, and no fill, line or shadow of
// its own drawn (the reader reads a prompt's as none).
function isPrompt(shape: ShapeNode): boolean {
	const props = shape.props

	return (
		!hasText(shape) &&
		(props?.fill === undefined || props.fill === "none") &&
		(props?.ln === undefined || props.ln === "none") &&
		(props?.effects === undefined || props.effects.effects.length === 0)
	)
}

// Elements a mirrored box is written for by a mirroring draw:transform (§19.229 scale with a negative factor).
const MIRRORED_BY_TRANSFORM: ReadonlySet<string> = new Set(["draw:polygon", "draw:polyline", "draw:path"])

// A mirrored box as draw:transform "scale (1 -1) rotate (a) translate (x y)" about the element's own origin: its
// vertical mirror, then its turn (a horizontal mirror is a vertical one half a turn round, ECMA-376 §20.1.7.6 and the
// reader's reading of a mirroring transform), its centre where the box's is.
export function mirroredBoxAttributes(box: Xfrm): AttributeChange[] {
	const vertical = box.flipH ? { rot: (box.rot + 10_800_000) % 21_600_000, flipV: !box.flipV } : { rot: box.rot, flipV: box.flipV }
	const size = [
		{ name: "svg:width", value: cm(box.cx) },
		{ name: "svg:height", value: cm(box.cy) }
	]

	if (!vertical.flipV) return boxAttributes({ ...box, rot: vertical.rot, flipH: false, flipV: false })

	const turned = -((vertical.rot / 60_000) * Math.PI) / 180
	const a = turned <= -Math.PI ? turned + 2 * Math.PI : turned > Math.PI ? turned - 2 * Math.PI : turned
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	// R(a) S (w/2, h/2) with S = scale (1, -1): the half-size point after the mirror and the turn.
	const halfW = box.cx / 2
	const halfH = -box.cy / 2
	const tx = box.x + box.cx / 2 - (cos * halfW + sin * halfH)
	const ty = box.y + box.cy / 2 - (-sin * halfW + cos * halfH)

	return [
		{ name: "svg:x", value: null },
		{ name: "svg:y", value: null },
		...size,
		{
			name: "draw:transform",
			value: `scale (1 -1) rotate (${String(Number(a.toFixed(10)))}) translate (${cm(Math.round(tx))} ${cm(Math.round(ty))})`
		}
	]
}

// LibreOffice mirrors a custom shape (draw:mirror-*) after its draw:transform turns it, DrawingML before: under one
// mirror the turn is written the other way. `invertsV`: the shape's vertical mirror is its ODF type's (a trapezoid).
export function mirrorTurn(box: Xfrm, invertsV = false): Xfrm {
	return box.flipH !== (box.flipV !== invertsV) && box.rot !== 0 ? { ...box, rot: (21_600_000 - box.rot) % 21_600_000 } : box
}

// svg:x/y/width/height of an unturned box; a turned one is placed by draw:transform about its corner.
export function boxAttributes(box: Xfrm): AttributeChange[] {
	const size = [
		{ name: "svg:width", value: cm(box.cx) },
		{ name: "svg:height", value: cm(box.cy) }
	]

	if (box.rot === 0) {
		return [{ name: "svg:x", value: cm(box.x) }, { name: "svg:y", value: cm(box.y) }, ...size, { name: "draw:transform", value: null }]
	}

	// The reader's angle a turns counter-clockwise; DrawingML's rot clockwise. Written as LibreOffice writes it (within
	// half a turn either way, to 10 decimals, the translation to the EMU), so a box turned back writes its source's text.
	const turned = -((box.rot / 60_000) * Math.PI) / 180
	const a = turned <= -Math.PI ? turned + 2 * Math.PI : turned > Math.PI ? turned - 2 * Math.PI : turned
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	const halfW = box.cx / 2
	const halfH = box.cy / 2
	const tx = box.x + halfW - (cos * halfW + sin * halfH)
	const ty = box.y + halfH - (-sin * halfW + cos * halfH)

	// Of the translations within an EMU, the one this box reads back from (the reader rounds again), so a box written,
	// read and written again keeps its text.
	const rotate = `rotate (${String(Number(a.toFixed(10)))})`
	const width = parseLength(cm(box.cx)) ?? 0
	const height = parseLength(cm(box.cy)) ?? 0
	let transform = `${rotate} translate (${cm(Math.round(tx))} ${cm(Math.round(ty))})`

	search: for (const dx of [0, -1, 1])
		for (const dy of [0, -1, 1]) {
			const candidate = `${rotate} translate (${cm(Math.round(tx) + dx)} ${cm(Math.round(ty) + dy)})`
			const matrix = transformMatrix(candidate)
			const read = matrix === undefined ? undefined : xfrmOf({ x: 0, y: 0, w: width, h: height }, matrix)

			if (read !== undefined && read.x === box.x && read.y === box.y) {
				transform = candidate
				break search
			}
		}

	return [{ name: "svg:x", value: null }, { name: "svg:y", value: null }, ...size, { name: "draw:transform", value: transform }]
}

// A preset's draw:enhanced-geometry for its box (an outline evaluated for a box depends on its size).
function presetMarkup(geometry: Geometry, box: Xfrm | undefined): string | Refused {
	if (geometry.kind !== "preset") {
		if (box === undefined) return refused("unsupported", "an outline without a box")

		const attributes = odfCustomAttributes(geometry.paths, geometry.textRect, box)

		return `<draw:enhanced-geometry${attributes.map(([name, value]) => ` ${name}="${value}"`).join("")}/>`
	}

	const markup = odfPresetGeometry(geometry.preset, geometry.guides, box ?? { cx: 0, cy: 0, flipH: false, flipV: false })

	if (markup === undefined) return refused("unsupported", `preset ${geometry.preset}`)
	if (box === undefined && presetDependsOnSize(geometry.preset, geometry.guides))
		return refused("unsupported", "an outline without a box")

	return markup
}

const JUMPS: Readonly<Record<string, string>> = {
	next: "next-page",
	previous: "previous-page",
	first: "first-page",
	last: "last-page",
	end: "stop",
	lastViewed: "last-visited-page"
}

// Whether a click action has an ODF form (presentation:action, §19.442): a jump, a page, a link. A custom show and a
// medium of the shape's own have none.
export function odpWritesAction(action: Action): boolean {
	return (action.kind === "internal" && JUMPS[action.jump] !== undefined) || action.kind === "slide" || action.kind === "url"
}

// A click action as presentation:event-listener (§10.4.3; the reader's mapping, inverted).
function listenerMarkup(action: Action, styles: OdpStyles): string | Refused {
	const head = '<presentation:event-listener script:event-name="dom:click"'

	switch (action.kind) {
		case "internal": {
			const jump = JUMPS[action.jump]

			return jump === undefined ? refused("unsupported", `jump ${action.jump}`) : `${head} presentation:action="${jump}"/>`
		}
		case "slide": {
			const name = styles.env.pageName(action.slide)

			return name === undefined
				? refused("notFound", "the slide an action jumps to")
				: `${head} presentation:action="show" xlink:href="#${escapeAttribute(name.replace(/%/gu, "%25"))}" xlink:type="simple"/>`
		}
		case "url":
			return `${head} presentation:action="show" xlink:href="${escapeAttribute(action.href)}" xlink:type="simple"/>`
		default:
			return refused("unsupported", `a ${action.kind} action`)
	}
}

export function markupOf(result: EmitResult): string | Refused {
	if (result.kind === "refused") return result
	if (result.kind === "unchanged") return ""

	let out = ""

	for (const piece of result.pieces) {
		if (typeof piece !== "string") return refused("failed", "nested markup with source spans")

		out += piece
	}

	return out
}
