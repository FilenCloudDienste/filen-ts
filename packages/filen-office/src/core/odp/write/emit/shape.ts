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
	fillChanges,
	isRefused,
	lineChanges,
	setProperty,
	styleChanges,
	type StyleChanges
} from "../styles"
import { resourceFillChanges, resourceLineChanges } from "../resources"
import { changedLengths } from "./box"
import { odpScaledTextChanges } from "./design"

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

// A group's mapping of its members' space (chOff/chExt) onto its own box, turned about the box's centre.
export function groupAffine(xfrm: Xfrm | undefined): Affine | Refused {
	if (xfrm === undefined) return IDENTITY
	if (xfrm.flipH || xfrm.flipV) return refused("unsupported", "a mirrored group")

	const chX = xfrm.chX ?? xfrm.x
	const chY = xfrm.chY ?? xfrm.y
	const chCx = xfrm.chCx ?? xfrm.cx
	const chCy = xfrm.chCy ?? xfrm.cy
	const sx = chCx === 0 ? 1 : xfrm.cx / chCx
	const sy = chCy === 0 ? 1 : xfrm.cy / chCy
	const scale: Affine = { a: sx, b: 0, c: 0, d: sy, e: xfrm.x - chX * sx, f: xfrm.y - chY * sy }

	if (xfrm.rot === 0) return scale

	const radians = (xfrm.rot / 60_000) * (Math.PI / 180)
	const cos = Math.cos(radians)
	const sin = Math.sin(radians)
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2
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
	const turn = Math.round(((Math.atan2(m.b, m.a) * 180) / Math.PI) * 60_000)
	const cx = Math.round(xfrm.cx * sx)
	const cy = Math.round(xfrm.cy * sy)

	return {
		x: Math.round(x - cx / 2),
		y: Math.round(y - cy / 2),
		cx,
		cy,
		rot: (((xfrm.rot + turn) % 21_600_000) + 21_600_000) % 21_600_000,
		flipH: xfrm.flipH,
		flipV: xfrm.flipV
	}
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

// DrawingML presets the reader takes from a custom shape's draw:type (read/shapes.ts PRESETS), by preset.
const TYPES: Readonly<Record<string, string>> = {
	rect: "rectangle",
	ellipse: "ellipse",
	roundRect: "round-rectangle",
	triangle: "isosceles-triangle",
	rtTriangle: "right-triangle",
	parallelogram: "parallelogram",
	trapezoid: "trapezoid",
	diamond: "diamond",
	hexagon: "hexagon",
	octagon: "octagon",
	pentagon: "pentagon",
	star5: "star5",
	rightArrow: "right-arrow",
	leftArrow: "left-arrow",
	upArrow: "up-arrow",
	downArrow: "down-arrow",
	cloud: "cloud",
	heart: "heart",
	smileyFace: "smiley",
	donut: "ring",
	plus: "cross",
	frame: "frame"
}

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
		if (shape.synthetic === true) return []

		const node = this.sourceNode(shape)
		const own = aspects ?? this.aspectsOf(shape) ?? {}
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
				const scope = rootScope(this.fragment.document)
				const kept = inScope(encodeUtf8(first), scope)

				out[0] = decodeUtf8(kept)
			} else if (first instanceof Uint8Array && this.fragment !== undefined) {
				out[0] = inScope(first, rootScope(this.fragment.document))
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

				return isRefused(markup) ? markup : [markup]
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
			const box = this.boxChanges(shape, name, m, fragment.attributes(node))

			if (isRefused(box)) return box

			changes.push(...changedLengths(box, fragment.attributes(node)))
		}

		const style = this.styleChange(shape, node, aspects)

		if (isRefused(style)) return style
		if (style !== undefined) changes.push(style)

		if (aspects.geometry === true) {
			const geometry = this.geometryChange(shape, node, name)

			if (isRefused(geometry)) return geometry

			changes.push(...geometry.attributes)
			if (geometry.enhanced !== undefined) replaced.set("draw:enhanced-geometry", geometry.enhanced)
		}

		if (aspects.text === true) {
			const text = this.text(shape)

			if (isRefused(text)) return text

			textMarkup = text

			if (fragment.attributes(node).get("presentation:placeholder") === "true" && hasText(shape))
				changes.push({ name: "presentation:placeholder", value: null })
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

		pieces.push(this.startTag(node, changes, false))

		const children = this.children(shape, node, name, m, replaced, textMarkup)

		if (isRefused(children)) return children

		pieces.push(...children, `</${document.name(node)}>`)

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

		for (const attribute of document.attributes(node)) {
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
		text: string | undefined
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
					if (!membersPlaced) out.push(...members)
					membersPlaced = true

					continue
				}

				const kept = this.keep(child, childName, replaced, done)

				if (kept !== undefined) out.push(kept)
			}

			if (!membersPlaced) out.push(...members)

			return out
		}

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)
			const childName = kind === NodeKind.Element ? fragment.name(child) : ""

			if (frame && childName === "draw:text-box" && text !== undefined && !textPlaced) {
				out.push(this.startTag(child, [], false), text, `</${document.name(child)}>`)
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

			out.push(...pieces)
		}

		return out
	}

	// --- Box. ---

	private boxChanges(shape: ShapeNode, name: string, m: Affine, attributes: ReadonlyMap<string, string>): AttributeChange[] | Refused {
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

		const box = placed(xfrm, m)

		if ((box.flipH || box.flipV) && name !== "draw:custom-shape") return refused("unsupported", `a mirrored ${name}`)

		const out = boxAttributes(box)

		if (attributes.has("presentation:class")) out.push({ name: "presentation:user-transformed", value: "true" })

		return out
	}

	// --- Style. ---

	private styleChange(shape: ShapeNode, node: number, aspects: Aspects): AttributeChange | Refused | undefined {
		const groups = (["fill", "ln", "effects", "bodyPr"] as const).filter(group => aspects[group] === true)

		if (groups.length === 0 && aspects.text !== true) return undefined

		const changes = styleChanges()
		const props = shape.props ?? {}

		for (const group of groups) {
			const failed =
				group === "fill"
					? fillChanges(changes, props.fill)
					: group === "ln"
						? lineChanges(changes, props.ln, aspects.pristine?.props?.ln)
						: group === "effects"
							? effectChanges(changes, props.effects)
							: bodyChanges(changes, props.bodyPr ?? {})

			if (failed !== undefined) return failed
		}

		// A body's text area travels with its text (text.bodyPr is what the shape's style says).
		if (aspects.text === true && aspects.bodyPr !== true && shape.text !== undefined) {
			const before = aspects.pristine?.text?.bodyPr

			if (before === undefined || JSON.stringify(before) !== JSON.stringify(shape.text.bodyPr)) {
				const failed = bodyChanges(changes, shape.text.bodyPr)

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

	// --- Geometry. ---

	private geometryChange(
		shape: ShapeNode,
		node: number,
		name: string
	): { readonly attributes: AttributeChange[]; readonly enhanced?: string } | Refused {
		const geometry = shape.props?.geometry

		if (geometry === undefined) return refused("unsupported", "a geometry taken back to the inherited one")

		if (name === "draw:custom-shape") {
			const type = presetType(geometry)

			if (isRefused(type)) return type

			const fragment = this.fragment as Fragment
			let enhanced = -1

			for (let child = fragment.document.firstChildElement(node); child >= 0; child = fragment.document.nextSiblingElement(child))
				if (fragment.name(child) === "draw:enhanced-geometry") enhanced = child

			const mirror = enhancedMirror(shape.xfrm)

			if (enhanced < 0) return { attributes: [], enhanced: `<draw:enhanced-geometry draw:type="${type}"${mirror}/>` }

			// The new outline is the type's: the old path, formulas and handles go.
			return { attributes: [], enhanced: `<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${type}"${mirror}/>` }
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

			return isRefused(markup) ? markup : [markup]
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
		const boxMarkup = boxAttributes(box)
			.filter(change => change.value !== null)
			.map(change => ` ${change.name}="${escapeAttribute(change.value as string)}"`)
			.join("")
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
			const style = placeholder === undefined ? this.newStyle(shape) : this.newPresentationStyle(shape, placeholder)

			if (isRefused(style)) return style

			const classes =
				placeholder === undefined
					? ""
					: ` presentation:class="${placeholder}"${hasText(shape) ? "" : ' presentation:placeholder="true"'} presentation:user-transformed="true"`

			return `<draw:frame${common}${style}${classes}${boxMarkup}><draw:text-box>${text}</draw:text-box>${listeners}${alt}</draw:frame>`
		}

		if (placeholder !== undefined) return refused("unsupported", "a placeholder with an outline")

		const type = rectangle
			? "rectangle"
			: geometry === undefined
				? refused("unsupported", "a new shape without an outline")
				: presetType(geometry)

		if (isRefused(type)) return type

		const style = this.newStyle(shape)

		if (isRefused(style)) return style

		return `<draw:custom-shape${common}${style}${boxMarkup}>${alt}${listeners}${text}<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${type}"${enhancedMirror(box)}/></draw:custom-shape>`
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

	private commonAttributes(shape: ShapeNode): string | Refused {
		let out = ""

		if (shape.name !== "") out += ` draw:name="${escapeAttribute(shape.name)}"`

		// A shape the slide's timing animates is named by its target id (core/anim/odf.ts odpTargetId).
		this.targets ??= odpTargetIds(this.slide.timing)

		if (this.targets.has(shape.id)) {
			const id = escapeAttribute(odpTargetId(shape, undefined, this.idPrefix))

			out += ` xml:id="${id}" draw:id="${id}"`
		}
		if (shape.hidden) out += ' draw:display="none"'

		return out
	}

	// A new shape's graphic style: its fill, line, shadow and text area.
	private newStyle(shape: ShapeNode): string | Refused {
		const changes = this.propsChanges(shape)

		if (isRefused(changes)) return changes
		if (changes.attributes.size === 0 && changes.children.size === 0) return ""

		return ` draw:style-name="${escapeAttribute(this.styles.derived("graphic", undefined, changes))}"`
	}

	// A new placeholder's presentation style: its master's for its class, with what the shape says over it.
	private newPresentationStyle(shape: ShapeNode, placeholder: string): string | Refused {
		const changes = this.propsChanges(shape)

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

	private propsChanges(shape: ShapeNode): StyleChanges | Refused {
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
			const failed = bodyChanges(changes, body)

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

// The canonical names of elements that are shapes (members of a page or a group).
export function isShapeElement(name: string): boolean {
	return name === "draw:a" || BOXED.has(name) || LINES.has(name) || name === "draw:g" || name === "draw:page-thumbnail"
}

function hasText(shape: ShapeNode): boolean {
	return shape.text?.paragraphs.some(paragraph => paragraph.runs.length > 0) ?? false
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

	// The reader's angle a turns counter-clockwise; DrawingML's rot clockwise.
	const a = -((box.rot / 60_000) * Math.PI) / 180
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	const halfW = box.cx / 2
	const halfH = box.cy / 2
	const tx = box.x + halfW - (cos * halfW + sin * halfH)
	const ty = box.y + halfH - (-sin * halfW + cos * halfH)

	return [
		{ name: "svg:x", value: null },
		{ name: "svg:y", value: null },
		...size,
		{ name: "draw:transform", value: `rotate (${a.toFixed(12)}) translate (${cm(tx)} ${cm(ty)})` }
	]
}

function enhancedMirror(xfrm: Xfrm | undefined): string {
	return `${xfrm?.flipH === true ? ' draw:mirror-horizontal="true"' : ""}${xfrm?.flipV === true ? ' draw:mirror-vertical="true"' : ""}`
}

function presetType(geometry: Geometry): string | Refused {
	if (geometry.kind !== "preset") return refused("unsupported", "a custom outline")
	if (geometry.guides.length > 0) return refused("unsupported", `adjusted ${geometry.preset}`)

	const type = TYPES[geometry.preset]

	return type === undefined ? refused("unsupported", `preset ${geometry.preset}`) : type
}

const JUMPS: Readonly<Record<string, string>> = {
	next: "next-page",
	previous: "previous-page",
	first: "first-page",
	last: "last-page",
	end: "stop"
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
