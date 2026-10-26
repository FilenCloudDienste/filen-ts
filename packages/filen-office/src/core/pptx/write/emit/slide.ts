import { colorXml } from "../../../presentation/render/markup"
import { CLR_MAP_KEYS } from "../../../presentation/theme"
import {
	refused,
	type Background,
	type ClrMap,
	type HeaderFooterFlags,
	type ListStyle,
	type Refused,
	type SlideKind,
	type SlideNode
} from "../../../presentation/model"
import { NodeKind, type XmlDocument } from "../../../xml/index"
import { G } from "../../read/xml"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import {
	Pieces,
	URIS,
	attr,
	childShapes,
	endTag,
	fillMarkup,
	mergeChildren,
	readerOf,
	sameModel,
	sameShape,
	sourceNode,
	splicing,
	startTag,
	unmodeledAttributes,
	type EmitContext,
	type Slot
} from "./shape"
import { listStyleXml } from "./text"

// The slide family's PresentationML: the root of a slide, layout, master, notes slide, notes master or handout master
// part (ECMA-376 Part 1 §19.3.1.38 p:sld, .39 p:sldLayout, .42 p:sldMaster, .26 p:notes, .27 p:notesMaster, .24
// p:handoutMaster) with its common slide data (p:cSld: background and shape tree) and its own levels (colour map or
// override, header/footer flags, text styles). Transitions, timing and extension lists stay as their source; the
// layout list of a master is the source's unless the fresh writer gives one.

const ROOTS: Readonly<Record<SlideKind, string>> = {
	slide: "sld",
	layout: "sldLayout",
	master: "sldMaster",
	notes: "notes",
	notesMaster: "notesMaster",
	handoutMaster: "handoutMaster"
}

export interface SlideRootOptions {
	// p:sldLayoutIdLst of a master, written by the caller (the fresh writer: new ids and relationships).
	readonly layoutList?: string
	// p:notesMasterIdLst… are presentation-level; nothing else is the caller's.
}

export function clrMapXml(tag: string, map: ClrMap): string {
	return `<${tag}${CLR_MAP_KEYS.map(key => attr(key, map[key])).join("")}/>`
}

function clrMapOvrXml(override: ClrMap | "master"): string {
	return override === "master"
		? "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>"
		: `<p:clrMapOvr>${clrMapXml("a:overrideClrMapping", override)}</p:clrMapOvr>`
}

function hfXml(hf: HeaderFooterFlags): string {
	return `<p:hf${hf.sldNum ? "" : ' sldNum="0"'}${hf.hdr ? "" : ' hdr="0"'}${hf.ftr ? "" : ' ftr="0"'}${hf.dt ? "" : ' dt="0"'}/>`
}

function backgroundXml(context: EmitContext, background: Background): string | Refused {
	if (background.kind === "ref")
		return `<p:bg><p:bgRef${attr("idx", background.idx)}>${background.color === undefined ? "" : colorXml(background.color)}</p:bgRef></p:bg>`

	const fill = fillMarkup(context, background.fill)

	return typeof fill === "string"
		? `<p:bg><p:bgPr${background.shadeToTitle === true ? ' shadeToTitle="1"' : ""}>${fill}<a:effectLst/></p:bgPr></p:bg>`
		: fill
}

function renamedList(context: EmitContext, tag: string, list: ListStyle, source: number): readonly EmitPiece[] | Refused {
	return listStyleXml(context, list, source, tag)
}

// p:txStyles of a master (title, body, other) or p:notesStyle of a notes master, from the model.
function textStylesXml(context: EmitContext, node: SlideNode, source: number): readonly EmitPiece[] | Refused {
	const styles = node.txStyles

	if (styles === undefined) return []

	const r = readerOf(context)
	const child = (local: string): number => (r === undefined || source < 0 ? -1 : r.child(source, G.P, local))

	if (node.kind === "notesMaster") return renamedList(context, "p:notesStyle", styles.body, source)

	const out = new Pieces().text("<p:txStyles>")

	for (const [tag, list] of [
		["titleStyle", styles.title],
		["bodyStyle", styles.body],
		["otherStyle", styles.other]
	] as const) {
		const written = renamedList(context, `p:${tag}`, list, child(tag))

		if (!Array.isArray(written)) return written as Refused

		out.append(written as readonly EmitPiece[])
	}

	const extLst = child("extLst")

	if (extLst >= 0) out.hole(extLst)

	return out.text("</p:txStyles>").out
}

// p:spTree: its own group properties kept, the shapes in model order.
function spTreeXml(context: EmitContext, node: SlideNode, source: number): readonly EmitPiece[] | Refused {
	const out = new Pieces()
	const r = readerOf(context)
	const shapes = childShapes(context, node.shapes)

	if (shapes.kind === "refused") return shapes

	if (r === undefined || source < 0) {
		out.text('<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>')
		out.text(
			'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
		)
		if (shapes.kind === "markup") out.append(shapes.pieces)

		return out.text("</p:spTree>").out
	}

	out.append([startTag(context, source)])

	// What precedes the first shape (the tree's own properties) and follows the last (its extension list), as written;
	// the shapes between in model order.
	const document = context.document as XmlDocument
	const isShape = (node: number): boolean => {
		if (document.kinds[node] !== NodeKind.Element) return false

		const group = r.group(node)
		const local = r.local(node)

		return !(group === G.P && (local === "nvGrpSpPr" || local === "grpSpPr" || local === "extLst"))
	}
	const children: number[] = []

	for (let child = document.firstChild(source); child >= 0; child = document.nextSibling(child)) children.push(child)

	const first = children.findIndex(isShape)
	const last = children.length - 1 - [...children].reverse().findIndex(isShape)
	const before =
		first < 0 ? children.filter(child => document.kinds[child] === NodeKind.Element && !isShape(child)) : children.slice(0, first)
	const after = first < 0 ? [] : children.slice(last + 1)

	for (const child of before) {
		// The whitespace before the first shape goes with that shape.
		if (first >= 0 && child === children[first - 1] && document.kinds[child] === NodeKind.Text) continue

		out.hole(child)
	}

	if (shapes.kind === "markup") out.append(shapes.pieces)

	for (const child of after) out.hole(child)

	return out.text(endTag(context, source)).out
}

// p:cSld: its name from the model, background as source (or the model's when it has none there), the shape tree.
function cSldXml(context: EmitContext, node: SlideNode, source: number, pristine: SlideNode | undefined): readonly EmitPiece[] | Refused {
	const out = new Pieces()
	let failure: Refused | undefined
	const take = (written: readonly EmitPiece[] | string | Refused): readonly EmitPiece[] | string => {
		if (typeof written === "string" || Array.isArray(written)) return written as readonly EmitPiece[] | string

		failure = written as Refused

		return ""
	}

	out.text(
		source >= 0
			? `<p:cSld${attr("name", node.name)}${unmodeledAttributes(context, source, new Set(["name"]))}>`
			: `<p:cSld${attr("name", node.name)}>`
	)

	const slots: Slot[] = [
		{
			match: (local, g) => g === G.P && local === "bg",
			write: bg => {
				if (bg >= 0 && (pristine === undefined || sameModel(node.background, pristine.background))) return "keep"
				if (bg >= 0 && splicing(context)) {
					failure = refused("notImplemented", "pptx emit design (background)")

					return ""
				}

				return node.background === undefined ? "" : take(backgroundXml(context, node.background))
			}
		},
		{ match: (local, g) => g === G.P && local === "spTree", write: tree => take(spTreeXml(context, node, tree)) }
	]

	mergeChildren(context, source, slots, out)

	return failure ?? out.text("</p:cSld>").out
}

const ROOT_ATTRIBUTES: Readonly<Record<SlideKind, ReadonlySet<string>>> = {
	slide: new Set(["show", "showMasterSp"]),
	layout: new Set(["showMasterSp"]),
	master: new Set(),
	notes: new Set(),
	notesMaster: new Set(),
	handoutMaster: new Set()
}

function rootAttributes(node: SlideNode): string {
	switch (node.kind) {
		case "slide":
			return `${node.showMasterShapes ? "" : ' showMasterSp="0"'}${node.hidden ? ' show="0"' : ""}`
		case "layout":
			return `${node.showMasterShapes ? "" : ' showMasterSp="0"'}${attr("type", node.layoutType === "cust" ? undefined : node.layoutType)}`
		default:
			return ""
	}
}

// Read at call time: this module and shape.ts import each other through emit.ts.
function declarations(): string {
	return `xmlns:a="${URIS["a"] ?? ""}" xmlns:r="${URIS["r"] ?? ""}" xmlns:p="${URIS["p"] ?? ""}"`
}

// The root element of a slide-like part, from its source root when it has one (`node.src` in the context's document).
export function slideRoot(context: EmitContext, node: SlideNode, options: SlideRootOptions = {}): EmitResult {
	const source = sourceNode(context, node.src)
	const pristine = splicing(context) ? context.pristine?.slide : undefined
	const r = readerOf(context)
	const tag = `p:${ROOTS[node.kind]}`
	const out = new Pieces()
	let failure: Refused | undefined
	const take = (written: readonly EmitPiece[] | Refused): readonly EmitPiece[] => {
		if (Array.isArray(written)) return written as readonly EmitPiece[]

		failure = written as Refused

		return []
	}

	// Unchanged since the source (splice): the root as it was.
	if (source >= 0 && pristine !== undefined && sameSlideContent(node, pristine)) return out.hole(source).markup()

	if (source >= 0 && r !== undefined) {
		const same = pristine !== undefined && node.hidden === pristine.hidden && node.showMasterShapes === pristine.showMasterShapes

		if (same) {
			out.append([startTag(context, source)])
		} else {
			const modeled = node.kind === "layout" ? new Set(["showMasterSp", "type"]) : ROOT_ATTRIBUTES[node.kind]

			out.text(`<${tag}${unmodeledAttributes(context, source, modeled)}${rootAttributes(node)}>`)
		}
	} else {
		out.text(`<${tag} ${declarations()}${rootAttributes(node)}>`)
	}

	const own = (local: string, write: (child: number) => "keep" | string | readonly EmitPiece[]): Slot => ({
		match: (name, g) => g === G.P && name === local,
		write
	})
	const slots: Slot[] = [own("cSld", child => take(cSldXml(context, node, child, pristine)))]

	if (node.kind === "master" || node.kind === "notesMaster" || node.kind === "handoutMaster") {
		slots.push(
			own("clrMap", child =>
				child >= 0 && (pristine === undefined || sameModel(node.clrMap, pristine.clrMap))
					? "keep"
					: node.clrMap === undefined
						? ""
						: clrMapXml("p:clrMap", node.clrMap)
			)
		)
	} else {
		slots.push(
			own("clrMapOvr", child =>
				child >= 0 && (pristine === undefined || sameModel(node.clrMapOvr, pristine.clrMapOvr))
					? "keep"
					: node.clrMapOvr === undefined
						? source < 0 && node.kind === "slide"
							? clrMapOvrXml("master")
							: ""
						: clrMapOvrXml(node.clrMapOvr)
			)
		)
	}

	if (node.kind === "master") slots.push(own("sldLayoutIdLst", () => options.layoutList ?? "keep"))

	slots.push(
		own("transition", () => "keep"),
		own("timing", () => "keep")
	)

	if (node.kind !== "slide" && node.kind !== "notes") {
		slots.push(
			own("hf", child =>
				child >= 0 && (pristine === undefined || sameModel(node.hf, pristine.hf))
					? "keep"
					: node.hf === undefined
						? ""
						: hfXml(node.hf)
			)
		)
	}

	if (node.kind === "master" || node.kind === "notesMaster") {
		const local = node.kind === "master" ? "txStyles" : "notesStyle"

		slots.push(
			own(local, child =>
				child >= 0 && pristine !== undefined && sameModel(node.txStyles, pristine.txStyles)
					? "keep"
					: take(textStylesXml(context, node, child))
			)
		)
	}

	slots.push(own("extLst", () => "keep"))
	mergeChildren(context, source, slots, out)

	if (failure !== undefined) return failure

	return out.text(source >= 0 ? endTag(context, source) : `</${tag}>`).markup()
}

// A slide alike its pristine read in everything the writer models.
function sameSlideContent(node: SlideNode, pristine: SlideNode): boolean {
	const fields = (slide: SlideNode): unknown => ({
		hidden: slide.hidden,
		showMasterShapes: slide.showMasterShapes,
		name: slide.name,
		layoutType: slide.layoutType,
		clrMap: slide.clrMap,
		clrMapOvr: slide.clrMapOvr,
		background: slide.background,
		hf: slide.hf,
		txStyles: slide.txStyles
	})

	return (
		sameModel(fields(node), fields(pristine)) &&
		node.shapes.length === pristine.shapes.length &&
		node.shapes.every((shape, index) => {
			const other = pristine.shapes[index]

			return other !== undefined && shape.src?.node === other.src?.node && sameShape(shape, other)
		})
	)
}

export const emitPptxSlide: PptxEmitFamily = {
	emit: (request, context) => slideRoot(context, request.slide)
}
