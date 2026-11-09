import { EMU_PER_PX, type TextBodyProps } from "../../../drawingml/index"
import { colorXml } from "../../../presentation/render/markup"
import {
	refused,
	type Action,
	type Bullet,
	type FontRef,
	type ListStyle,
	type Paragraph,
	type ParaProps,
	type Refused,
	type Run,
	type RunProps,
	type ShapeNode,
	type Spacing,
	type TextBody
} from "../../../presentation/model"
import { Relationships } from "../../../opc/index"
import { classifyAction } from "../../../presentation/actions"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS } from "../../../presentation/budget"
import { NodeKind, escapeText } from "../../../xml/index"
import { readTextBody } from "../../read/drawing"
import { G } from "../../read/xml"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import {
	IMAGE_RELATIONSHIP,
	Pieces,
	URIS,
	actionPieces,
	attr,
	childElements,
	effectListXml,
	fillMarkup,
	lineMarkup,
	mergeChildren,
	readerOf,
	registerTextBody,
	sameModel,
	sourceNode,
	splicing,
	unmodeledAttributes,
	type EmitContext
} from "./shape"
import { isRefused } from "../../../presentation/refusal"

// The text family's PresentationML: p:txBody of a shape (ECMA-376 Part 1 §21.1.2: a:bodyPr, a:lstStyle, a:p with
// a:r, a:br, a:fld and a:endParaRPr). Paragraphs, runs and their properties are written from the model; whatever the
// model does not hold of a property element (an attribute or child it does not read: dirty flags, a:rtl, extension
// lists) is kept from the source element in the same place. In splice mode a paragraph, its pPr or a run that reads
// back as the model holds it is its source span.

// Characters XML 1.0 cannot hold (§2.2): a body holding one is refused, never written broken.
function invalidXml(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) return true
	}

	return false
}

function percent(value: number): number {
	return Math.round(value)
}

function spacingXml(tag: string, spacing: Spacing | undefined): string {
	if (spacing === undefined) return ""

	return "pct" in spacing
		? `<a:${tag}><a:spcPct${attr("val", percent(spacing.pct))}/></a:${tag}>`
		: `<a:${tag}><a:spcPts${attr("val", spacing.pts)}/></a:${tag}>`
}

function fontXml(tag: string, font: FontRef | undefined): string {
	if (font === undefined) return ""

	return `<a:${tag}${attr("typeface", font.typeface)}${attr("panose", font.panose)}${attr("pitchFamily", font.pitchFamily)}${attr("charset", font.charset)}/>`
}

const RUN_ATTRIBUTES: ReadonlySet<string> = new Set([
	"sz",
	"b",
	"i",
	"u",
	"strike",
	"baseline",
	"cap",
	"spc",
	"kern",
	"lang",
	"altLang",
	"noProof"
])
const RUN_CHILDREN: ReadonlySet<string> = new Set([
	"ln",
	"noFill",
	"solidFill",
	"gradFill",
	"blipFill",
	"pattFill",
	"grpFill",
	"effectLst",
	"highlight",
	"uLnTx",
	"uLn",
	"uFillTx",
	"uFill",
	"latin",
	"ea",
	"cs",
	"sym",
	"hlinkClick",
	"hlinkMouseOver"
])

// a:rPr / a:defRPr / a:endParaRPr (CT_TextCharacterProperties, §21.1.2.3.2) from the model; `source` is the element
// it replaces (its unmodeled attributes and children stay).
export function runPropsXml(context: EmitContext, tag: string, props: RunProps, source: number): readonly EmitPiece[] | Refused {
	const out = new Pieces().text(
		`<${tag}${attr("lang", props.lang)}${attr("altLang", props.altLang)}${attr("sz", props.sz)}${attr("b", props.b)}${attr("i", props.i)}` +
			`${attr("u", props.u)}${attr("strike", props.strike)}${attr("kern", props.kern)}${attr("cap", props.cap)}${attr("spc", props.spc)}` +
			`${attr("baseline", props.baseline === undefined ? undefined : percent(props.baseline))}${attr("noProof", props.noProof)}` +
			unmodeledAttributes(context, source, RUN_ATTRIBUTES)
	)
	const children = new Pieces()
	let failure: Refused | undefined
	const value = (written: string | Refused): string => {
		if (typeof written === "string") return written

		failure = written

		return ""
	}

	children.text(props.ln === undefined ? "" : value(lineMarkup(context, props.ln)))
	children.text(props.fill === undefined ? "" : value(fillMarkup(context, props.fill)))
	children.text(props.effects === undefined ? "" : effectListXml(props.effects))
	children.text(props.highlight === undefined ? "" : `<a:highlight>${colorXml(props.highlight)}</a:highlight>`)

	if (props.uLn === "text") children.text("<a:uLnTx/>")
	else if (props.uLn !== undefined) children.text(value(lineMarkup(context, props.uLn, "a:uLn")))

	if (props.uFill === "text") children.text("<a:uFillTx/>")
	else if (props.uFill !== undefined) children.text(`<a:uFill>${value(fillMarkup(context, props.uFill))}</a:uFill>`)

	children.text(fontXml("latin", props.latin) + fontXml("ea", props.ea) + fontXml("cs", props.cs) + fontXml("sym", props.sym))

	for (const [name, action] of [
		["hlinkClick", props.hlinkClick],
		["hlinkMouseOver", props.hlinkMouseOver]
	] as const) {
		if (action === undefined) continue

		const r = readerOf(context)
		const kept = r === undefined || source < 0 ? -1 : r.child(source, G.A, name)
		const markup = actionPieces(context, `a:${name}`, action, kept, true)
		// A refused action is written only as the source wrote it: a run made from one (part of it formatted
		// otherwise) carries the element of a source run with that action, as PowerPoint copies it onto both.
		const donor = markup !== undefined || kept >= 0 ? kept : actionDonor(context, name, action)

		if (markup !== undefined) children.append(markup)
		else if (donor >= 0) children.hole(donor)
		else return refused("unsupported", `A ${action.kind} text action cannot be written from the model`)
	}

	// What the model does not read (a:rtl, a:extLst…) stays, after what it writes (both are last in the sequence).
	const document = context.document

	if (document !== undefined && source >= 0) {
		const r = readerOf(context)

		for (const child of childElements(document, source)) {
			if (r?.group(child) === G.A && RUN_CHILDREN.has(document.localName(child))) continue

			children.hole(child)
		}
	}

	if (failure !== undefined) return failure
	if (children.out.length === 0) return out.text("/>").out

	return out.text(">").append(children.out).text(`</${tag}>`).out
}

const PARA_ATTRIBUTES: ReadonlySet<string> = new Set([
	"lvl",
	"algn",
	"marL",
	"marR",
	"indent",
	"defTabSz",
	"rtl",
	"eaLnBrk",
	"latinLnBrk",
	"hangingPunct",
	"fontAlgn"
])

function bulletXml(context: EmitContext, bullet: Bullet | undefined): string {
	if (bullet === undefined) return ""

	switch (bullet.kind) {
		case "none":
			return "<a:buNone/>"
		case "char":
			return `<a:buChar${attr("char", bullet.char)}/>`
		case "autoNum":
			return `<a:buAutoNum${attr("type", bullet.scheme)}${attr("startAt", bullet.startAt)}/>`
		case "blip":
			return `<a:buBlip><a:blip${attr("r:embed", context.parts.relate(bullet.part, IMAGE_RELATIONSHIP))}/></a:buBlip>`
	}
}

// a:pPr / a:lvlNpPr / a:defPPr (CT_TextParagraphProperties, §21.1.2.2.7) from the model; `source`'s unmodeled
// attributes and its extension list stay.
export function paraPropsXml(context: EmitContext, tag: string, props: ParaProps, source: number): readonly EmitPiece[] | Refused {
	const out = new Pieces().text(
		`<${tag}${attr("marL", props.marL)}${attr("marR", props.marR)}${attr("lvl", props.lvl)}` +
			`${attr("indent", props.indent)}${attr("algn", props.algn)}${attr("defTabSz", props.defTabSz)}${attr("rtl", props.rtl)}` +
			`${attr("eaLnBrk", props.eaLnBrk)}${attr("fontAlgn", props.fontAlgn)}${attr("latinLnBrk", props.latinLnBrk)}` +
			`${attr("hangingPunct", props.hangingPunct)}` +
			unmodeledAttributes(context, source, PARA_ATTRIBUTES)
	)
	const children = new Pieces()

	children.text(spacingXml("lnSpc", props.lnSpc) + spacingXml("spcBef", props.spcBef) + spacingXml("spcAft", props.spcAft))

	if (props.buClr === "text") children.text("<a:buClrTx/>")
	else if (props.buClr !== undefined) children.text(`<a:buClr>${colorXml(props.buClr)}</a:buClr>`)

	if (props.buSz === "text") children.text("<a:buSzTx/>")
	else if (props.buSz !== undefined)
		children.text(
			"pct" in props.buSz ? `<a:buSzPct${attr("val", percent(props.buSz.pct))}/>` : `<a:buSzPts${attr("val", props.buSz.pts)}/>`
		)

	if (props.buFont === "text") children.text("<a:buFontTx/>")
	else children.text(fontXml("buFont", props.buFont))

	children.text(bulletXml(context, props.bullet))

	if (props.tabs !== undefined) {
		children.text(
			props.tabs.length === 0
				? "<a:tabLst/>"
				: `<a:tabLst>${props.tabs.map(tab => `<a:tab${attr("pos", tab.pos)}${attr("algn", tab.algn)}/>`).join("")}</a:tabLst>`
		)
	}

	if (props.defRPr !== undefined) {
		const r = readerOf(context)
		const sourceDef = r === undefined || source < 0 ? -1 : r.child(source, G.A, "defRPr")
		const def = runPropsXml(context, "a:defRPr", props.defRPr, sourceDef)

		if (isRefused(def)) return def

		children.append(def)
	}

	const r = readerOf(context)
	const extLst = r === undefined || source < 0 ? -1 : r.child(source, G.A, "extLst")

	if (extLst >= 0) children.hole(extLst)
	if (children.out.length === 0) return out.text("/>").out

	return out.text(">").append(children.out).text(`</${tag}>`).out
}

// a:lstStyle (CT_TextListStyle): a:defPPr, a:lvl1pPr…a:lvl9pPr, from the model; the source's extension list kept.
export function listStyleXml(context: EmitContext, list: ListStyle, source: number, tag = "a:lstStyle"): readonly EmitPiece[] | Refused {
	const out = new Pieces().text(`<${tag}>`)
	const r = readerOf(context)
	const sourceLevel = (local: string): number => (r === undefined || source < 0 ? -1 : r.child(source, G.A, local))

	if (list.def !== undefined) {
		const def = paraPropsXml(context, "a:defPPr", list.def, sourceLevel("defPPr"))

		if (isRefused(def)) return def

		out.append(def)
	}

	for (let level = 0; level < 9; level++) {
		const props = list.levels[level]

		if (props === undefined) continue

		const written = paraPropsXml(context, `a:lvl${String(level + 1)}pPr`, props, sourceLevel(`lvl${String(level + 1)}pPr`))

		if (isRefused(written)) return written

		out.append(written)
	}

	const extLst = sourceLevel("extLst")

	if (extLst >= 0) out.hole(extLst)

	return out.text(`</${tag}>`).out
}

const BODY_ATTRIBUTES: ReadonlySet<string> = new Set([
	"lIns",
	"tIns",
	"rIns",
	"bIns",
	"anchor",
	"anchorCtr",
	"vert",
	"wrap",
	"rot",
	"upright",
	"numCol",
	"spcCol"
])
const AUTOFIT: ReadonlySet<string> = new Set(["noAutofit", "normAutofit", "spAutoFit"])

function inset(value: number | undefined): number | undefined {
	return value === undefined || Number.isNaN(value) ? undefined : Math.round(value * EMU_PER_PX)
}

// a:bodyPr (CT_TextBodyProperties, §21.1.2.1.1) from the model's attributes as written; the source's unmodeled
// attributes and children (prstTxWarp, scene3d, sp3d, flatTx, extLst) stay in place.
export function bodyPrXml(context: EmitContext, props: Partial<TextBodyProps>, source: number): readonly EmitPiece[] {
	const insets = props.insets
	const out = new Pieces().text(
		`<a:bodyPr${attr("rot", props.rotation === undefined ? undefined : props.rotation * 60000)}${attr("vert", props.vertical)}` +
			`${attr("wrap", props.wrap === undefined ? undefined : props.wrap ? "square" : "none")}` +
			`${attr("lIns", inset(insets?.left))}${attr("tIns", inset(insets?.top))}${attr("rIns", inset(insets?.right))}${attr("bIns", inset(insets?.bottom))}` +
			`${attr("numCol", props.columns)}${attr("spcCol", props.columnSpacing === undefined ? undefined : props.columnSpacing * EMU_PER_PX)}` +
			`${attr("anchor", props.anchor)}${attr("anchorCtr", props.anchorCenter)}${attr("upright", props.upright)}` +
			unmodeledAttributes(context, source, BODY_ATTRIBUTES) +
			">"
	)
	const autofit =
		props.autofit === "shape"
			? "<a:spAutoFit/>"
			: props.autofit === "normal"
				? `<a:normAutofit${props.fontScale === undefined || props.fontScale === 1 ? "" : attr("fontScale", props.fontScale * 100000)}` +
					`${props.lineSpacingReduction === undefined || props.lineSpacingReduction === 0 ? "" : attr("lnSpcReduction", props.lineSpacingReduction * 100000)}/>`
				: props.autofit === "none"
					? "<a:noAutofit/>"
					: ""

	mergeChildren(
		context,
		source,
		[
			{ match: (local, g) => g === G.A && local === "prstTxWarp", write: () => "keep" },
			{ match: (local, g) => g === G.A && AUTOFIT.has(local), write: () => autofit },
			{ match: (local, g) => g === G.A && local === "scene3d", write: () => "keep" },
			{ match: (local, g) => g === G.A && (local === "sp3d" || local === "flatTx"), write: () => "keep" },
			{ match: (local, g) => g === G.A && local === "extLst", write: () => "keep" }
		],
		out
	)

	return out.text("</a:bodyPr>").out
}

// The run elements of a source paragraph, in the order the reader models them (r, br, fld, mc:AlternateContent).
function sourceRuns(context: EmitContext, paragraph: number): number[] {
	const r = readerOf(context)

	if (r === undefined || paragraph < 0) return []

	const out: number[] = []

	for (let child = r.first(paragraph); child >= 0; child = r.next(child)) {
		const group = r.group(child)
		const local = r.local(child)

		if ((group === G.MC && local === "AlternateContent") || (group === G.A && (local === "r" || local === "br" || local === "fld")))
			out.push(child)
	}

	return out
}

// The a:hlinkClick or a:hlinkMouseOver (`name`) of a source run of the slide that reads as `action`; -1 when none.
function actionDonor(context: EmitContext, name: "hlinkClick" | "hlinkMouseOver", action: Action): number {
	const r = readerOf(context)

	if (r === undefined) return -1

	for (const [node, paragraph] of context.pristine?.paragraphs ?? []) {
		const runs = sourceRuns(context, node)

		for (let at = 0; at < paragraph.runs.length; at++) {
			const run = paragraph.runs[at]
			const source = runs[at] ?? -1

			if (source < 0 || run === undefined || run.kind === "opaque" || !sameModel(run.rPr[name], action)) continue

			const rPr = r.child(source, G.A, "rPr")
			const element = rPr < 0 ? -1 : r.child(rPr, G.A, name)

			if (element >= 0) return element
		}
	}

	return -1
}

function runXml(context: EmitContext, run: Run, source: number): readonly EmitPiece[] | Refused {
	const r = readerOf(context)
	const rPrOf = (): number => (r === undefined || source < 0 ? -1 : r.child(source, G.A, "rPr"))
	// An empty a:rPr is written only where the source has one (it is optional, §21.1.2.3.8).
	const rPrPieces = (props: RunProps): readonly EmitPiece[] | Refused =>
		Object.keys(props).length === 0 && rPrOf() < 0 ? [] : runPropsXml(context, "a:rPr", props, rPrOf())

	switch (run.kind) {
		case "opaque": {
			const node = sourceNode(context, run.src)

			return node < 0 ? refused("unsupported", "Run content kept as its source, without its source") : [{ hole: node }]
		}
		case "br": {
			const rPr = rPrPieces(run.rPr)

			return isRefused(rPr) ? rPr : new Pieces().text("<a:br>").append(rPr).text("</a:br>").out
		}
		case "r":
		case "fld": {
			if (invalidXml(run.text)) return refused("malformed", "Text holding characters XML cannot hold")

			const rPr = rPrPieces(run.rPr)

			if (isRefused(rPr)) return rPr

			const out = new Pieces()

			if (run.kind === "r") {
				out.text("<a:r>")
			} else {
				out.text(`<a:fld${attr("id", run.id)}${attr("type", run.type === "" ? undefined : run.type)}>`)
			}

			out.append(rPr)

			if (run.kind === "fld" && r !== undefined && source >= 0) {
				const pPr = r.child(source, G.A, "pPr")

				if (pPr >= 0) out.hole(pPr)
			}

			return out.text(`<a:t>${escapeText(run.text)}</a:t>${run.kind === "r" ? "</a:r>" : "</a:fld>"}`).out
		}
	}
}

// One a:p: the source span when it reads back as the model holds it (splice), else written from the model, its pPr
// and runs matched with the source paragraph's by position.
function paragraphXml(context: EmitContext, paragraph: Paragraph, basis: Basis | undefined): readonly EmitPiece[] | Refused {
	const node = sourceNode(context, paragraph.src)
	const pristine = node < 0 ? undefined : basis?.paragraphs.get(node)
	const same = basis?.same ?? sameModel

	if (pristine !== undefined && same(paragraph, pristine)) return [{ hole: node }]

	const r = readerOf(context)
	const out = new Pieces().text(node >= 0 ? `<a:p${unmodeledAttributes(context, node, new Set())}>` : "<a:p>")
	const pPrNode = r === undefined || node < 0 ? -1 : r.child(node, G.A, "pPr")

	if (pPrNode >= 0 && pristine !== undefined && same(paragraph.pPr, pristine.pPr)) {
		out.hole(pPrNode)
	} else if (Object.keys(paragraph.pPr).length > 0 || pPrNode >= 0) {
		const pPr = paraPropsXml(context, "a:pPr", paragraph.pPr, pPrNode)

		if (isRefused(pPr)) return pPr

		out.append(pPr)
	}

	const runs = sourceRuns(context, node)

	for (let index = 0; index < paragraph.runs.length; index++) {
		const run = paragraph.runs[index]
		const source = runs[index] ?? -1

		if (run === undefined) continue
		if (source >= 0 && pristine !== undefined && same(run, pristine.runs[index])) {
			out.hole(source)

			continue
		}

		const written = runXml(context, run, source)

		if (isRefused(written)) return written

		out.append(written)
	}

	if (paragraph.endRPr !== undefined) {
		const endNode = r === undefined || node < 0 ? -1 : r.child(node, G.A, "endParaRPr")

		if (endNode >= 0 && pristine !== undefined && same(paragraph.endRPr, pristine.endRPr)) {
			out.hole(endNode)
		} else {
			const end = runPropsXml(context, "a:endParaRPr", paragraph.endRPr, endNode)

			if (isRefused(end)) return end

			out.append(end)
		}
	}

	if (r !== undefined && node >= 0) {
		const extLst = r.child(node, G.A, "extLst")

		if (extLst >= 0) out.hole(extLst)
	}

	return out.text("</a:p>").out
}

// What "as the source reads" means for a body: the pristine read (splice), or the source body read again here (model
// mode), whose actions are compared only when the source's relationships are at hand (without them a hyperlink
// reads as nothing, so actions are left out of the comparison and kept by their source elements).
interface Basis {
	readonly body: TextBody
	readonly paragraphs: ReadonlyMap<number, Paragraph>
	readonly same: (a: unknown, b: unknown) => boolean
}

const ACTION_KEYS: ReadonlySet<string> = new Set(["hlinkClick", "hlinkMouseOver"])

function withoutActions(value: unknown): unknown {
	if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value
	if (Array.isArray(value)) return value.map(withoutActions)

	const out: Record<string, unknown> = {}

	for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (!ACTION_KEYS.has(key)) out[key] = withoutActions(item)

	return out
}

function basisOf(context: EmitContext, shape: ShapeNode, source: number): Basis | undefined {
	if (splicing(context)) {
		const body = context.pristine?.shapes.get(sourceNode(context, shape.src))?.text

		return body === undefined || context.pristine === undefined
			? undefined
			: { body, paragraphs: context.pristine.paragraphs, same: sameModel }
	}

	const r = readerOf(context)

	if (r === undefined || source < 0) return undefined

	const relationships = context.relationships
	const read = readTextBody(
		{
			reader: r,
			part: shape.src?.part ?? context.parts.owner,
			epoch: shape.src?.epoch ?? 0,
			relationships: relationships ?? internalRelationships(context, r, source),
			tally: new DeckTally(DEFAULT_PRESENTATION_BUDGETS),
			action: node => (relationships === undefined ? undefined : classifyNode(context, r, relationships, node))
		},
		source
	)
	const paragraphs = new Map<number, Paragraph>()

	for (const paragraph of read.paragraphs) if (paragraph.src !== undefined) paragraphs.set(paragraph.src.node, paragraph)

	return {
		body: read,
		paragraphs,
		same: relationships === undefined ? (a, b) => sameModel(withoutActions(a), withoutActions(b)) : sameModel
	}
}

// The internal relationships a source subtree names, from the emit's PartsApi (picture fills and bullets resolve to
// their parts; external targets stay unknown, so actions are not compared).
function internalRelationships(context: EmitContext, r: NonNullable<ReturnType<typeof readerOf>>, source: number): Relationships {
	const document = r.document
	const seen = new Map<string, string>()

	for (let node = source; node < document.count && document.start(node) < document.end(source); node++) {
		if (document.kinds[node] !== NodeKind.Element) continue

		for (const attribute of document.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon < 0 || seen.has(attribute.value)) continue
			if (r.namespaces.uri(node, attribute.name.slice(0, colon)) !== URIS["r"]) continue

			const target = context.parts.target(attribute.value)

			if (target !== undefined) seen.set(attribute.value, target)
		}
	}

	return new Relationships(
		[...seen].map(([id, target]) => ({
			id,
			type: "",
			target,
			external: false,
			partName: target.startsWith("/") ? target.slice(1) : target
		}))
	)
}

// A hyperlink element classified as the reader classifies it (a slide jump by the deck's own slide parts).
function classifyNode(
	context: EmitContext,
	r: ReturnType<typeof readerOf> & object,
	relationships: Relationships,
	node: number
): Action | undefined {
	const id = r.rel(node, "id")
	const target = id === undefined || id === "" ? undefined : relationships.byId(id)
	const action = r.attr(node, "action")

	return classifyAction(
		{
			...(action === undefined ? {} : { action }),
			...(target === undefined
				? {}
				: {
						target: {
							external: target.external,
							target: target.target,
							...(target.partName === undefined ? {} : { partName: `/${target.partName}` })
						}
					})
		},
		{
			slideOf: part => {
				for (const ref of context.deck.slides) if (context.deck.nodes.get(ref)?.part === part) return ref

				return undefined
			}
		}
	)
}

// p:txBody of `shape` (or the element `tag` names: a:txBody in tables).
export function textBodyXml(context: EmitContext, shape: ShapeNode, body: TextBody, source: number, tag = "p:txBody"): EmitResult {
	const r = readerOf(context)
	const basis = basisOf(context, shape, source)
	const pristine = basis?.body
	const same = basis?.same ?? sameModel
	const out = new Pieces().text(source >= 0 ? `<${tag}${unmodeledAttributes(context, source, new Set())}>` : `<${tag}>`)
	const bodyProps = shape.props?.bodyPr === undefined ? body.bodyPr : { ...body.bodyPr, ...shape.props.bodyPr }
	const bodyPrNode = r === undefined || source < 0 ? -1 : r.child(source, G.A, "bodyPr")
	const lstStyleNode = r === undefined || source < 0 ? -1 : r.child(source, G.A, "lstStyle")
	let failure: Refused | undefined

	if (bodyPrNode >= 0 && pristine !== undefined && same(bodyProps, pristine.bodyPr)) out.hole(bodyPrNode)
	else out.append(bodyPrXml(context, bodyProps, bodyPrNode))

	if (lstStyleNode >= 0 && pristine !== undefined && same(body.lstStyle, pristine.lstStyle)) {
		out.hole(lstStyleNode)
	} else if (body.lstStyle !== undefined) {
		const list = listStyleXml(context, body.lstStyle, lstStyleNode)

		if (isRefused(list)) return list

		out.append(list)
	}

	for (const paragraph of body.paragraphs) {
		const written = paragraphXml(context, paragraph, basis)

		if (isRefused(written)) {
			failure = written

			break
		}

		out.append(written)
	}

	// CT_TextBody holds at least one paragraph.
	if (body.paragraphs.length === 0) out.text("<a:p/>")

	return failure ?? out.text(`</${tag}>`).markup()
}

export const emitPptxText: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape?.text === undefined) return refused("failed", "A text emit without a text body")

		const r = readerOf(context)
		const element = sourceNode(context, shape.src)
		const source = r === undefined || element < 0 ? -1 : r.child(element, G.P, "txBody")

		return textBodyXml(context, shape, shape.text, source)
	}
}

registerTextBody((request, context) => emitPptxText.emit(request, context))
