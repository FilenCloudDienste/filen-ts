import { spliceAll } from "../arrays"
import { D, drawingReader, type DrawingReader } from "../drawingml/reader"
import { matchesIn, type Matcher } from "../presentation/edit/find"
import { refused, type Refused } from "../presentation/model"
import { escapeAttribute, escapeText } from "../xml/entities"
import { decodeUtf8, encodeUtf8, parseXml, XmlEditor, type XmlDocument } from "../xml/index"
import { DEFAULT_SMARTART_BUDGETS, parseDataModel, SmartArtError, type DataModel, type DataPoint, type PointType } from "./data"
import { isPendingImageId, PART_IMAGE_ID } from "./emit"

// Editing a diagram's data model (ECMA-376 §21.4.3 dgm:dataModel) as the text pane and Find & Replace do: node text,
// adding, removing, promoting, demoting and moving nodes, replacing text, and the layout, style and colours a diagram
// names. Every edit is a set of byte splices over the part (core/xml XmlEditor), so what an edit does not touch keeps
// its bytes: unknown points, connections, extensions, run properties. The tree is the one parseDataModel reads (one
// parent per point, srcOrd order); an edit that moves a node rewrites its parOf connection and renumbers the srcOrd of
// the children of each parent it changed. The presentation points the last layout wrote are its cache: after a change
// of structure their style counts are dropped (the next layout counts again), a removed node takes its own with it,
// and a change of layout drops them all (their names are the old layout's). The drawing cache (dsp:dataModelExt) is
// dropped by every edit: the diagram is laid out again.

export const DGM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
export const DSP_URI = "http://schemas.microsoft.com/office/drawing/2008/diagram"
const A_URI = "http://schemas.openxmlformats.org/drawingml/2006/main"
const R_URI = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
// a:ext@uri of the drawing cache's reference in a data part's extLst (MS-ODRAWXML §2.3.4).
export const DATA_MODEL_EXT_URI = "http://schemas.microsoft.com/office/drawing/2008/diagram"
// Our own attribute on a detached dsp:dataModelExt (held parts only: the writer replaces the extension).
const MARK_URI = "urn:filen:office:smartart"
const MARK_PREFIX = "filenSmartArt"

// A diagram's parts by role (ECMA-376 §21.4; MS-ODRAWXML §2.4 for the drawing cache), with their content types.
export const DIAGRAM_CONTENT_TYPES = {
	data: "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml",
	layout: "application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml",
	style: "application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml",
	colors: "application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml",
	drawing: "application/vnd.ms-office.drawingml.diagramDrawing+xml"
} as const

export type DiagramPart = keyof typeof DIAGRAM_CONTENT_TYPES

export const DIAGRAM_PARTS: readonly DiagramPart[] = ["data", "layout", "style", "colors", "drawing"]

const TEXT_TYPES: ReadonlySet<PointType> = new Set(["node", "asst"])
const POINT_TYPES: ReadonlySet<string> = new Set(["doc", "node", "asst", "parTrans", "sibTrans", "pres"])
const TRANSITION_TYPES: ReadonlySet<PointType> = new Set(["parTrans", "sibTrans"])
const LEVEL_TABS = /^\t*/u

export type NodePosition = "before" | "after" | "above" | "below"

export type DiagramEdit =
	| { readonly kind: "setNodeText"; readonly node: string; readonly text: string }
	| {
			readonly kind: "addNode"
			readonly relativeTo: string
			readonly position: NodePosition
			readonly text?: string
			readonly id?: string
	  }
	| { readonly kind: "removeNode"; readonly node: string }
	| { readonly kind: "promote" | "demote"; readonly node: string }
	| { readonly kind: "moveNode"; readonly node: string; readonly direction: "up" | "down" }
	// Every match in the text points' find text (diagramFindTexts), or only `match`: [text point index, start, end].
	| {
			readonly kind: "replace"
			readonly matcher: Matcher
			readonly replacement: string
			readonly match?: readonly [number, number, number]
	  }
	// The layout, style or colours definition the doc point names (dgm:prSet loTypeId/qsTypeId/csTypeId and their
	// categories). A new layout drops the presentation points.
	| {
			readonly kind: "setDefinition"
			readonly which: "layout" | "style" | "colors"
			readonly uniqueId: string
			readonly category?: string
			// A new layout's picture placeholder (the layout node a picture fills): the presentation points holding a
			// picture are kept under that name, so their pictures stay; without one they are kept as they are.
			readonly pictureName?: string
	  }
	// A picture into the placeholder `placeholder` (a layout node's name) of node `node`: the presentation point's
	// spPr fill, made when there is none. `embed` names the image (a pending id, emit.ts INSERTED_IMAGE_ID), `crop`
	// is its srcRect (1/100,000 of the image per edge).
	| {
			readonly kind: "setPicture"
			readonly node: string
			readonly placeholder: string
			readonly embed: string
			readonly crop?: { readonly l: number; readonly t: number; readonly r: number; readonly b: number }
	  }

export type DiagramEditResult =
	| {
			readonly kind: "edited"
			readonly bytes: Uint8Array
			// addNode: the new node's modelId.
			readonly id?: string
			// replace: how many matches were replaced.
			readonly replaced?: number
	  }
	// Nothing to change (a replace without a match).
	| { readonly kind: "unchanged" }
	| Refused

// One node of the diagram as the text pane lists it: depth 1 under the doc point.
export interface DiagramOutlineNode {
	readonly id: string
	readonly level: number
	readonly type: "node" | "asst"
	readonly text: string
}

function refusalOf(error: unknown): Refused {
	if (error instanceof SmartArtError) return refused(error.reason, error.message)

	return refused("malformed", error instanceof Error ? error.message : "diagram data")
}

function modelOf(document: XmlDocument): DataModel | Refused {
	try {
		return parseDataModel(document)
	} catch (error) {
		return refusalOf(error)
	}
}

// The node and assistant children of a point, in srcOrd order.
function textChildren(point: DataPoint): DataPoint[] {
	return point.children.filter(child => TEXT_TYPES.has(child.type))
}

// The outline the text pane shows: every node and assistant point under the doc point, depth first in srcOrd order.
export function diagramOutline(document: XmlDocument): readonly DiagramOutlineNode[] | Refused {
	const model = modelOf(document)

	if ("kind" in model) return model

	const out: DiagramOutlineNode[] = []
	const stack: { point: DataPoint; level: number }[] = textChildren(model.root)
		.reverse()
		.map(point => ({ point, level: 1 }))

	while (stack.length > 0) {
		const { point, level } = stack.pop() as { point: DataPoint; level: number }

		out.push({ id: point.id, level, type: point.type === "asst" ? "asst" : "node", text: point.paragraphs.join("\n") })

		const children = textChildren(point)

		for (let i = children.length - 1; i >= 0; i--) stack.push({ point: children[i] as DataPoint, level: level + 1 })
	}

	return out
}

// --- The part as elements ---

interface Pt {
	readonly node: number
	readonly id: string
	readonly type: PointType
}

interface Cxn {
	readonly node: number
	readonly id: string | undefined
	readonly type: string
	readonly src: string | undefined
	readonly dest: string | undefined
}

class DataPart {
	readonly document: XmlDocument
	readonly reader: DrawingReader
	readonly root: number
	readonly ptLst: number
	readonly cxnLst: number
	// Points with a modelId in document order, the first of each id (as parseDataModel reads them).
	readonly pts: Pt[] = []
	readonly ptById = new Map<string, Pt>()
	readonly cxns: Cxn[] = []
	// Prefixes for new markup: the dataModel's own (empty for a default namespace), and DrawingML's when the root binds it.
	readonly dgm: string
	readonly a: string | undefined

	constructor(document: XmlDocument) {
		this.document = document
		this.reader = drawingReader(document)

		const reader = this.reader

		this.root = document.documentElement()
		this.ptLst = reader.child(this.root, D.Dgm, "ptLst")
		this.cxnLst = reader.child(this.root, D.Dgm, "cxnLst")

		const dgm = reader.namespaces.prefixFor(this.root, DGM_URI)

		this.dgm = dgm === undefined || dgm === "" ? "" : `${dgm}:`

		const a = reader.namespaces.prefixFor(this.root, A_URI)

		this.a = a === undefined ? undefined : a === "" ? "" : `${a}:`

		for (const pt of reader.children(this.ptLst, D.Dgm, "pt")) {
			const id = reader.attr(pt, "modelId")

			if (id === undefined || this.ptById.has(id)) continue

			const typeText = reader.attr(pt, "type") ?? "node"
			const entry: Pt = { node: pt, id, type: POINT_TYPES.has(typeText) ? (typeText as PointType) : "node" }

			this.pts.push(entry)
			this.ptById.set(id, entry)
		}

		for (const cxn of reader.children(this.cxnLst, D.Dgm, "cxn")) {
			this.cxns.push({
				node: cxn,
				id: reader.attr(cxn, "modelId"),
				type: reader.attr(cxn, "type") ?? "parOf",
				src: reader.attr(cxn, "srcId"),
				dest: reader.attr(cxn, "destId")
			})
		}
	}

	// The parOf connection that hangs `child` under `parent` (the one parseDataModel took: the lowest srcOrd).
	parOf(parent: string, child: string): number {
		let best = -1
		let bestOrd = Number.POSITIVE_INFINITY

		for (const cxn of this.cxns) {
			if (cxn.type !== "parOf" || cxn.src !== parent || cxn.dest !== child) continue

			const ord = this.reader.number(cxn.node, "srcOrd", 0)

			if (ord < bestOrd) {
				best = cxn.node
				bestOrd = ord
			}
		}

		return best
	}

	// Whether any attribute names a relationship of the part (a picture in a placeholder): such a part cannot be
	// written under a new name without its relationships.
	hasRelationships(): boolean {
		const document = this.document

		for (let node = 1; node < document.count; node++) {
			for (const attribute of document.attributes(node)) {
				const colon = attribute.name.indexOf(":")

				if (
					colon > 0 &&
					attribute.name.slice(0, colon) !== "xmlns" &&
					!isPendingImageId(attribute.value) &&
					this.reader.namespaces.uri(node, attribute.name.slice(0, colon)) === R_URI
				)
					return true
			}
		}

		return false
	}

	tag(local: string): string {
		return `${this.dgm}${local}`
	}

	// DrawingML markup for new text: the root's prefix, or "a:" declared on the element written.
	aPrefix(): { prefix: string; declare: string } {
		return this.a === undefined ? { prefix: "a:", declare: ` xmlns:a="${A_URI}"` } : { prefix: this.a, declare: "" }
	}
}

// --- New markup ---

// A modelId no point or connection of the part has: a GUID in braces, as PowerPoint writes them, numbered from a seed
// so the ids an edit makes are the same every time it is applied.
class Ids {
	private readonly used = new Set<string>()
	private next: number

	constructor(part: DataPart, seed: string) {
		for (const pt of part.pts) this.used.add(pt.id.toUpperCase())
		for (const cxn of part.cxns) if (cxn.id !== undefined) this.used.add(cxn.id.toUpperCase())

		let hash = 0x811c9dc5

		for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193)

		this.next = (hash >>> 0) % 0x10000000
	}

	take(wanted?: string): string {
		if (wanted !== undefined && wanted !== "" && !this.used.has(wanted.toUpperCase())) {
			this.used.add(wanted.toUpperCase())

			return wanted
		}

		for (;;) {
			const tail = (this.next++).toString(16).toUpperCase().padStart(12, "0")
			const id = `{F11E0000-5A00-4000-8000-${tail.slice(-12)}}`

			if (!this.used.has(id)) {
				this.used.add(id)

				return id
			}
		}
	}
}

function paragraphsXml(prefix: string, text: string, runProps: (index: number) => string, paraProps: (index: number) => string): string {
	let out = ""

	text.split("\n").forEach((line, index) => {
		const pPr = paraProps(index)
		const rPr = runProps(index)

		out +=
			line === ""
				? `<${prefix}p>${pPr}<${prefix}endParaRPr lang="en-US"/></${prefix}p>`
				: `<${prefix}p>${pPr}<${prefix}r>${rPr === "" ? `<${prefix}rPr lang="en-US"/>` : rPr}<${prefix}t>${escapeText(line)}</${prefix}t></${prefix}r></${prefix}p>`
	})

	return out
}

function newTextXml(part: DataPart, text: string): string {
	const { prefix, declare } = part.aPrefix()

	return `<${part.tag("t")}${declare}><${prefix}bodyPr/><${prefix}lstStyle/>${paragraphsXml(
		prefix,
		text,
		() => "",
		() => ""
	)}</${part.tag("t")}>`
}

// A node point, its two transitions and the parOf connection that hangs it under `parent` at `srcOrd`.
function newNodeXml(
	part: DataPart,
	ids: Ids,
	parent: string,
	srcOrd: number,
	text: string,
	wanted?: string
): { readonly id: string; readonly pts: string; readonly cxn: string } {
	const id = ids.take(wanted)
	const cxnId = ids.take()
	const parTrans = ids.take()
	const sibTrans = ids.take()
	const pt = part.tag("pt")
	const empty = newTextXml(part, "")
	const pts =
		`<${pt} modelId="${escapeAttribute(id)}"><${part.tag("prSet")} phldrT="[Text]"/><${part.tag("spPr")}/>${newTextXml(part, text)}</${pt}>` +
		`<${pt} modelId="${parTrans}" type="parTrans" cxnId="${cxnId}"><${part.tag("prSet")}/><${part.tag("spPr")}/>${empty}</${pt}>` +
		`<${pt} modelId="${sibTrans}" type="sibTrans" cxnId="${cxnId}"><${part.tag("prSet")}/><${part.tag("spPr")}/>${empty}</${pt}>`
	const cxn = `<${part.tag("cxn")} modelId="${cxnId}" srcId="${escapeAttribute(parent)}" destId="${escapeAttribute(id)}" srcOrd="${String(srcOrd)}" destOrd="0" parTransId="${parTrans}" sibTransId="${sibTrans}"/>`

	return { id, pts, cxn }
}

// --- Edits ---

// The drawing cache reference (dsp:dataModelExt) detached: its relId emptied, so nothing draws the stale cache, and
// the relationship it named kept on an attribute of our own, so the writer puts the new drawing in that part.
function dropDrawingCache(part: DataPart, editor: XmlEditor): void {
	const reader = part.reader
	const extLst = reader.child(part.root, D.Dgm, "extLst")

	for (const ext of reader.children(extLst, D.A, "ext")) {
		const model = reader.child(ext, D.Dsp, "dataModelExt")
		const relId = model < 0 ? undefined : reader.attr(model, "relId")

		if (relId === undefined || relId === "") continue

		editor.setAttribute(model, "relId", "")
		editor.setAttribute(model, `xmlns:${MARK_PREFIX}`, MARK_URI)
		editor.setAttribute(model, `${MARK_PREFIX}:relId`, relId)
	}
}

// A data part held again from its bytes (an undo after a save rewrote the part): its drawing cache detached as an edit
// detaches it, since the relationship it names now holds another drawing.
export function detachDrawingCache(document: XmlDocument): Uint8Array {
	const editor = new XmlEditor(document)

	dropDrawingCache(new DataPart(document), editor)

	return editor.serialize()
}

// The relationship (of the slide) the data part's drawing cache was in before an edit detached it.
export function detachedDrawingRelId(document: XmlDocument): string | undefined {
	const reader = drawingReader(document)
	const extLst = reader.child(document.documentElement(), D.Dgm, "extLst")

	for (const ext of reader.children(extLst, D.A, "ext")) {
		const model = reader.child(ext, D.Dsp, "dataModelExt")

		if (model < 0) continue

		for (const attribute of document.attributes(model)) {
			const colon = attribute.name.indexOf(":")

			if (
				colon > 0 &&
				attribute.name.slice(colon + 1) === "relId" &&
				reader.namespaces.uri(model, attribute.name.slice(0, colon)) === MARK_URI
			)
				return attribute.value === "" ? undefined : attribute.value
		}
	}

	return undefined
}

function childCount(document: XmlDocument, node: number): number {
	let count = 0

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) count++

	return count
}

interface Outline {
	readonly point: DataPoint
	parent: Outline | undefined
	readonly children: Outline[]
	// Its parOf connection element; -1 for a node this edit adds.
	cxn: number
}

// The node tree of the model, with each node's parOf connection.
function outlineOf(part: DataPart, model: DataModel): { root: Outline; byId: Map<string, Outline> } {
	const byId = new Map<string, Outline>()
	const root: Outline = { point: model.root, parent: undefined, children: [], cxn: -1 }
	const stack: Outline[] = [root]

	byId.set(model.root.id, root)

	while (stack.length > 0) {
		const at = stack.pop() as Outline

		for (const child of textChildren(at.point)) {
			const entry: Outline = { point: child, parent: at, children: [], cxn: part.parOf(at.point.id, child.id) }

			at.children.push(entry)
			byId.set(child.id, entry)
			stack.push(entry)
		}
	}

	return { root, byId }
}

// Rewrites the parOf connections of every child of `parents` (srcId and srcOrd), in their outline order; new
// children's connections are added by the caller.
function writeChildren(part: DataPart, editor: XmlEditor, parents: Iterable<Outline>): void {
	const reader = part.reader

	for (const parent of parents) {
		parent.children.forEach((child, index) => {
			if (child.cxn < 0) return
			if (reader.attr(child.cxn, "srcId") !== parent.point.id) editor.setAttribute(child.cxn, "srcId", parent.point.id)
			if (reader.number(child.cxn, "srcOrd", Number.NaN) !== index) editor.setAttribute(child.cxn, "srcOrd", String(index))
		})
	}
}

// The presentation points' style counts dropped (a change of structure: the next layout counts again).
function dropStyleCounts(part: DataPart, editor: XmlEditor, removed: ReadonlySet<string>): void {
	const reader = part.reader

	for (const pt of part.pts) {
		if (pt.type !== "pres" || removed.has(pt.id)) continue

		const prSet = reader.child(pt.node, D.Dgm, "prSet")

		if (prSet < 0) continue
		if (reader.attr(prSet, "presStyleIdx") !== undefined) editor.removeAttribute(prSet, "presStyleIdx")
		if (reader.attr(prSet, "presStyleCnt") !== undefined) editor.removeAttribute(prSet, "presStyleCnt")
	}
}

// Points removed with the connections that name them: a node takes its transitions and the presentation points
// associated with it; presOf and presParOf connections of a removed point go too.
function removePoints(part: DataPart, editor: XmlEditor, ids: ReadonlySet<string>): Set<string> {
	const reader = part.reader
	const gone = new Set(ids)

	for (const cxn of part.cxns) {
		if (cxn.type !== "parOf" || cxn.dest === undefined || !ids.has(cxn.dest)) continue

		for (const name of ["parTransId", "sibTransId"]) {
			const trans = reader.attr(cxn.node, name)

			const type = trans === undefined ? undefined : part.ptById.get(trans)?.type

			if (trans !== undefined && type !== undefined && TRANSITION_TYPES.has(type)) gone.add(trans)
		}
	}

	for (const pt of part.pts) {
		if (pt.type !== "pres") continue

		const assoc = reader.attr(reader.child(pt.node, D.Dgm, "prSet"), "presAssocID")

		if (assoc !== undefined && gone.has(assoc)) gone.add(pt.id)
	}

	for (const pt of part.pts) if (gone.has(pt.id)) editor.remove(pt.node)

	for (const cxn of part.cxns) {
		if ((cxn.dest !== undefined && gone.has(cxn.dest)) || (cxn.type !== "parOf" && cxn.src !== undefined && gone.has(cxn.src)))
			editor.remove(cxn.node)
	}

	return gone
}

function appendPoints(part: DataPart, editor: XmlEditor, pts: string, cxns: string): void {
	if (pts !== "") editor.append(part.ptLst, pts)
	if (cxns === "") return
	if (part.cxnLst >= 0) editor.append(part.cxnLst, cxns)
	else editor.insertAfter(part.ptLst, `<${part.tag("cxnLst")}>${cxns}</${part.tag("cxnLst")}>`)
}

function finish(editor: XmlEditor, extra: { id?: string; replaced?: number } = {}): DiagramEditResult {
	return { kind: "edited", bytes: editor.serialize(), ...extra }
}

function setNodeText(part: DataPart, editor: XmlEditor, id: string, text: string): DiagramEditResult {
	const pt = part.ptById.get(id)

	if (pt === undefined || !TEXT_TYPES.has(pt.type)) return refused("notFound", `diagram node ${id}`)

	const reader = part.reader
	const document = part.document
	const t = reader.child(pt.node, D.Dgm, "t")

	if (t < 0) {
		const extLst = reader.child(pt.node, D.Dgm, "extLst")
		const markup = newTextXml(part, text)

		if (extLst >= 0) editor.insertBefore(extLst, markup)
		else editor.append(pt.node, markup)

		dropDrawingCache(part, editor)

		return finish(editor)
	}

	// The body's properties and list style stay; each line takes the run and paragraph properties of the paragraph at
	// its index (the last one past the end), so a retyped node keeps its formatting.
	const paragraphs = reader.children(t, D.A, "p")
	const raw = (node: number): string => (node < 0 ? "" : decodeUtf8(document.raw(node)))
	const paragraphAt = (index: number): number => paragraphs[Math.min(index, paragraphs.length - 1)] ?? -1
	const runProps = (index: number): string => {
		const p = paragraphAt(index)

		if (p < 0) return ""

		for (let r = document.firstChildElement(p); r >= 0; r = document.nextSiblingElement(r)) {
			if (reader.is(r, D.A, "r") || reader.is(r, D.A, "fld")) return raw(reader.child(r, D.A, "rPr"))
		}

		const end = reader.child(p, D.A, "endParaRPr")

		if (end < 0) return ""

		// endParaRPr's properties as the run's (same type, CT_TextCharacterProperties).
		const markup = raw(end)
		const name = document.name(end)
		const runName = name.slice(0, name.length - "endParaRPr".length) + "rPr"

		return markup.replace(new RegExp(`^<${name}`, "u"), `<${runName}`).replace(new RegExp(`</${name}>$`, "u"), `</${runName}>`)
	}
	const paraProps = (index: number): string => {
		const p = paragraphAt(index)

		return p < 0 ? "" : raw(reader.child(p, D.A, "pPr"))
	}
	const a = paragraphs.length > 0 ? document.name(paragraphs[0] as number).slice(0, -1) : part.aPrefix().prefix
	let body = ""

	for (let child = document.firstChildElement(t); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.is(child, D.A, "bodyPr") || reader.is(child, D.A, "lstStyle")) body += raw(child)
	}

	editor.setContent(t, body + paragraphsXml(a, text, runProps, paraProps))
	dropDrawingCache(part, editor)

	return finish(editor)
}

function addNode(
	part: DataPart,
	editor: XmlEditor,
	model: DataModel,
	relativeTo: string,
	position: NodePosition,
	text: string,
	wanted: string | undefined
): DiagramEditResult {
	if (part.pts.length + 3 > DEFAULT_SMARTART_BUDGETS.maxPoints) return refused("tooLarge", "diagram points")

	const { root, byId } = outlineOf(part, model)
	const at = byId.get(relativeTo)

	if (at === undefined) return refused("notFound", `diagram node ${relativeTo}`)

	const isRoot = at === root

	if (isRoot && position !== "below") return refused("unsupported", "a node beside the diagram's root")

	const ids = new Ids(part, `${relativeTo}\u0000${position}\u0000${wanted ?? ""}`)
	const parent = position === "below" ? at : (at.parent as Outline)
	const index = position === "below" ? at.children.length : parent.children.indexOf(at) + (position === "after" ? 1 : 0)
	const created = newNodeXml(part, ids, parent.point.id, index, text, wanted)
	const node: Outline = { point: at.point, parent, children: [], cxn: -1 }

	parent.children.splice(index, 0, node)

	if (position === "above") {
		// The new node takes `at`'s place; `at` (with its subtree) becomes its only child.
		parent.children.splice(parent.children.indexOf(at), 1)

		const cxn = at.cxn

		if (cxn >= 0) {
			editor.setAttribute(cxn, "srcId", created.id)
			editor.setAttribute(cxn, "srcOrd", "0")
		}
	}

	writeChildren(part, editor, [parent])
	appendPoints(part, editor, created.pts, created.cxn)
	dropStyleCounts(part, editor, new Set())
	dropDrawingCache(part, editor)

	return finish(editor, { id: created.id })
}

function removeNode(part: DataPart, editor: XmlEditor, model: DataModel, id: string): DiagramEditResult {
	const { root, byId } = outlineOf(part, model)
	const at = byId.get(id)

	if (at === undefined || at === root) return refused("notFound", `diagram node ${id}`)

	// Its children take its place under its parent, in their order.
	const parent = at.parent as Outline
	const index = parent.children.indexOf(at)

	spliceAll(parent.children, index, 1, at.children)

	for (const child of at.children) child.parent = parent

	const gone = removePoints(part, editor, new Set([id]))

	writeChildren(part, editor, [parent])
	dropStyleCounts(part, editor, gone)
	dropDrawingCache(part, editor)

	return finish(editor)
}

function promote(part: DataPart, editor: XmlEditor, model: DataModel, id: string): DiagramEditResult {
	const { root, byId } = outlineOf(part, model)
	const at = byId.get(id)

	if (at === undefined || at === root) return refused("notFound", `diagram node ${id}`)

	const parent = at.parent as Outline

	if (parent === root) return refused("unsupported", "a top-level node cannot be promoted")

	const grand = parent.parent as Outline
	const index = parent.children.indexOf(at)
	// The siblings after it become its children (an outline's promote).
	const following = parent.children.splice(index)

	following.shift()

	for (const child of following) {
		child.parent = at
		at.children.push(child)
	}

	grand.children.splice(grand.children.indexOf(parent) + 1, 0, at)
	at.parent = grand

	writeChildren(part, editor, [grand, at])
	dropStyleCounts(part, editor, new Set())
	dropDrawingCache(part, editor)

	return finish(editor)
}

function demote(part: DataPart, editor: XmlEditor, model: DataModel, id: string): DiagramEditResult {
	const { root, byId } = outlineOf(part, model)
	const at = byId.get(id)

	if (at === undefined || at === root) return refused("notFound", `diagram node ${id}`)

	const parent = at.parent as Outline
	const index = parent.children.indexOf(at)
	const previous = parent.children[index - 1]

	if (previous === undefined) return refused("unsupported", "a first child cannot be demoted")

	parent.children.splice(index, 1)
	previous.children.push(at)
	at.parent = previous

	writeChildren(part, editor, [parent, previous])
	dropStyleCounts(part, editor, new Set())
	dropDrawingCache(part, editor)

	return finish(editor)
}

function moveNode(part: DataPart, editor: XmlEditor, model: DataModel, id: string, direction: "up" | "down"): DiagramEditResult {
	const { root, byId } = outlineOf(part, model)
	const at = byId.get(id)

	if (at === undefined || at === root) return refused("notFound", `diagram node ${id}`)

	const siblings = (at.parent as Outline).children
	const index = siblings.indexOf(at)
	const other = index + (direction === "up" ? -1 : 1)

	if (other < 0 || other >= siblings.length) return refused("unsupported", `the node is ${direction === "up" ? "first" : "last"}`)

	siblings[index] = siblings[other] as Outline
	siblings[other] = at

	writeChildren(part, editor, [at.parent as Outline])
	dropStyleCounts(part, editor, new Set())
	dropDrawingCache(part, editor)

	return finish(editor)
}

// --- Find and replace ---

interface TextRun {
	// a:r (plain text a match may lie in), a:fld or a:br (find text, never replaced).
	readonly kind: "r" | "fld" | "br"
	readonly node: number
	// The a:t holding the run's text (-1 for a:br or a run without one).
	readonly t: number
	readonly text: string
	// Offset in the point's find text.
	readonly start: number
}

interface TextPoint {
	readonly pt: Pt
	readonly text: string
	readonly runs: readonly TextRun[]
}

// The text points of the part in data order (the order find counts them), each with its find text: its paragraphs'
// runs (a:br as "\n"), paragraphs joined by "\n".
function textPoints(part: DataPart): TextPoint[] {
	const reader = part.reader
	const document = part.document
	const out: TextPoint[] = []

	for (const pt of part.pts) {
		if (!TEXT_TYPES.has(pt.type)) continue

		const runs: TextRun[] = []
		let text = ""
		const t = reader.child(pt.node, D.Dgm, "t")
		const paragraphs = t < 0 ? [] : reader.children(t, D.A, "p")

		paragraphs.forEach((p, index) => {
			if (index > 0) text += "\n"

			for (let r = document.firstChildElement(p); r >= 0; r = document.nextSiblingElement(r)) {
				if (reader.is(r, D.A, "r") || reader.is(r, D.A, "fld")) {
					const tNode = reader.child(r, D.A, "t")
					const value = reader.text(tNode)

					runs.push({ kind: reader.is(r, D.A, "r") ? "r" : "fld", node: r, t: tNode, text: value, start: text.length })
					text += value
				} else if (reader.is(r, D.A, "br")) {
					runs.push({ kind: "br", node: r, t: -1, text: "\n", start: text.length })
					text += "\n"
				}
			}
		})

		out.push({ pt, text, runs })
	}

	return out
}

// The find text of each text point, in data order (what find searches: FIND_IN_SMARTART's paragraph is the index).
export function diagramFindTexts(document: XmlDocument): readonly string[] {
	return textPoints(new DataPart(document)).map(point => point.text)
}

// The plain runs a match [start, end) lies in, when it lies only in a:r runs of one paragraph (a paragraph's "\n"
// is in no run, so a match across one is not covered).
function coveredRuns(point: TextPoint, start: number, end: number): TextRun[] | undefined {
	const out: TextRun[] = []
	let covered = 0

	for (const run of point.runs) {
		const runEnd = run.start + run.text.length

		if (runEnd <= start || run.start >= end) continue
		if (run.kind !== "r" || run.t < 0) return undefined

		out.push(run)
		covered += Math.min(end, runEnd) - Math.max(start, run.start)
	}

	return out.length === 0 || covered !== end - start ? undefined : out
}

function replace(
	part: DataPart,
	editor: XmlEditor,
	matcher: Matcher,
	replacement: string,
	only: readonly [number, number, number] | undefined
): DiagramEditResult {
	const points = textPoints(part)
	let replaced = 0

	for (let index = 0; index < points.length; index++) {
		if (only !== undefined && index !== only[0]) continue

		const point = points[index] as TextPoint
		const matches: [number, number][] = []

		matchesIn(point.text, matcher, (start, end) => {
			if (only === undefined || (start === only[1] && end === only[2])) matches.push([start, end])

			return true
		})

		// Each run's new text, matches applied right to left so earlier offsets hold.
		const texts = new Map<TextRun, string>()
		const removed = new Set<TextRun>()

		for (let m = matches.length - 1; m >= 0; m--) {
			const [start, end] = matches[m] as [number, number]
			const runs = coveredRuns(point, start, end)

			if (runs === undefined) continue

			runs.forEach((run, k) => {
				const current = texts.get(run) ?? run.text
				const from = Math.max(0, start - run.start)
				const to = Math.min(run.text.length, end - run.start)

				if (k === 0) texts.set(run, current.slice(0, from) + replacement + current.slice(to))
				else if (to >= run.text.length && from === 0 && current.length === run.text.length) removed.add(run)
				else texts.set(run, current.slice(0, from) + current.slice(to))
			})
			replaced++
		}

		for (const [run, text] of texts) if (!removed.has(run)) editor.setText(run.t, text)
		for (const run of removed) editor.remove(run.node)
	}

	if (only !== undefined && replaced === 0) return refused("stale", "the match is no longer there")
	if (replaced === 0) return { kind: "unchanged" }

	dropDrawingCache(part, editor)

	return finish(editor, { replaced })
}

const DEFINITION_ATTRIBUTES = {
	layout: ["loTypeId", "loCatId"],
	style: ["qsTypeId", "qsCatId"],
	colors: ["csTypeId", "csCatId"]
} as const

function setDefinition(
	part: DataPart,
	editor: XmlEditor,
	which: "layout" | "style" | "colors",
	uniqueId: string,
	category: string | undefined,
	pictureName?: string
): DiagramEditResult {
	const reader = part.reader
	const doc = part.pts.find(pt => pt.type === "doc")

	if (doc === undefined) return refused("malformed", "no doc point")

	const [typeName, catName] = DEFINITION_ATTRIBUTES[which]
	const prSet = reader.child(doc.node, D.Dgm, "prSet")

	if (prSet >= 0) {
		editor.setAttribute(prSet, typeName, uniqueId)
		if (category !== undefined) editor.setAttribute(prSet, catName, category)
		else if (reader.attr(prSet, catName) !== undefined) editor.removeAttribute(prSet, catName)
	} else {
		const markup = `<${part.tag("prSet")} ${typeName}="${escapeAttribute(uniqueId)}"${category === undefined ? "" : ` ${catName}="${escapeAttribute(category)}"`}/>`

		editor.prepend(doc.node, markup)
	}

	if (which === "layout") {
		// The presentation points are the old layout's; those holding a picture are the user's and stay, under the new
		// layout's picture placeholder when it has one.
		const pictures = part.pts.filter(pt => pt.type === "pres" && holdsPicture(part, pt.node))
		const kept = new Set(pictures.map(pt => pt.id))

		removePoints(part, editor, new Set(part.pts.filter(pt => pt.type === "pres" && !kept.has(pt.id)).map(pt => pt.id)))

		for (const pt of pictures) {
			const prSet = reader.child(pt.node, D.Dgm, "prSet")

			if (prSet < 0) continue
			if (pictureName !== undefined) editor.setAttribute(prSet, "presName", pictureName)

			for (const name of ["presStyleIdx", "presStyleCnt"])
				if (reader.attr(prSet, name) !== undefined) editor.removeAttribute(prSet, name)
		}
	}

	dropDrawingCache(part, editor)

	return finish(editor)
}

const FILL_NAMES: ReadonlySet<string> = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])
// CT_ShapeProperties children that come before the fill.
const BEFORE_FILL: ReadonlySet<string> = new Set(["xfrm", "custGeom", "prstGeom"])

// Whether a presentation point's dgm:spPr fills its shape with a picture.
function holdsPicture(part: DataPart, pt: number): boolean {
	const reader = part.reader

	return reader.child(reader.child(pt, D.Dgm, "spPr"), D.A, "blipFill") >= 0
}

function blipFillXml(part: DataPart, embed: string, crop: Extract<DiagramEdit, { kind: "setPicture" }>["crop"]): string {
	const { prefix, declare } = part.aPrefix()
	const edge = (name: string, value: number): string => (Math.round(value) === 0 ? "" : ` ${name}="${String(Math.round(value))}"`)
	const source = crop === undefined ? "" : `${edge("l", crop.l)}${edge("t", crop.t)}${edge("r", crop.r)}${edge("b", crop.b)}`

	return (
		`<${prefix}blipFill${declare} xmlns:r="${R_URI}" rotWithShape="1"><${prefix}blip r:embed="${escapeAttribute(embed)}"/>` +
		`<${prefix}srcRect${source}/><${prefix}stretch><${prefix}fillRect/></${prefix}stretch></${prefix}blipFill>`
	)
}

function setPicture(
	part: DataPart,
	editor: XmlEditor,
	model: DataModel,
	edit: Extract<DiagramEdit, { kind: "setPicture" }>
): DiagramEditResult {
	const point = model.points.get(edit.node)

	if (point === undefined || (point.type !== "node" && point.type !== "asst")) return refused("notFound", `node ${edit.node}`)
	if (edit.placeholder === "") return refused("malformed", "a picture placeholder without a name")

	const reader = part.reader
	const fill = blipFillXml(part, edit.embed, edit.crop)
	const pres = part.pts.find(pt => {
		if (pt.type !== "pres") return false

		const prSet = reader.child(pt.node, D.Dgm, "prSet")

		return reader.attr(prSet, "presAssocID") === edit.node && reader.attr(prSet, "presName") === edit.placeholder
	})

	if (pres === undefined) {
		const ids = new Ids(part, `${edit.node}\u0000${edit.placeholder}`)
		const pt = part.tag("pt")

		appendPoints(
			part,
			editor,
			`<${pt} modelId="${ids.take()}" type="pres"><${part.tag("prSet")} presAssocID="${escapeAttribute(edit.node)}" presName="${escapeAttribute(edit.placeholder)}"/>` +
				`<${part.tag("spPr")}>${fill}</${part.tag("spPr")}></${pt}>`,
			""
		)
	} else {
		const spPr = reader.child(pres.node, D.Dgm, "spPr")

		if (spPr < 0) {
			const prSet = reader.child(pres.node, D.Dgm, "prSet")
			const markup = `<${part.tag("spPr")}>${fill}</${part.tag("spPr")}>`

			if (prSet >= 0) editor.insertAfter(prSet, markup)
			else editor.prepend(pres.node, markup)
		} else {
			let before = -1
			let placed = false

			for (let child = part.document.firstChildElement(spPr); child >= 0; child = part.document.nextSiblingElement(child)) {
				if (reader.group(child) !== D.A) continue

				const name = part.document.localName(child)

				if (BEFORE_FILL.has(name)) before = child
				else if (FILL_NAMES.has(name)) {
					if (placed) editor.remove(child)
					else editor.replace(child, fill)

					placed = true
				}
			}

			if (!placed) {
				if (before >= 0) editor.insertAfter(before, fill)
				else editor.prepend(spPr, fill)
			}
		}
	}

	dropDrawingCache(part, editor)

	return finish(editor)
}

// Every relationship a data part names (r:embed, r:link, r:id on its pictures), as a pending id naming the target part
// (emit.ts PART_IMAGE_ID), so the part no longer needs relationships of its own: undefined when it names none; refused
// when one is no part of the package (an external link).
export function pendDataRelationships(document: XmlDocument, target: (id: string) => string | undefined): Uint8Array | Refused | undefined {
	const part = new DataPart(document)
	const editor = new XmlEditor(document)
	let changed = false

	for (let node = 1; node < document.count; node++) {
		for (const attribute of document.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon <= 0 || attribute.name.slice(0, colon) === "xmlns" || isPendingImageId(attribute.value)) continue
			if (part.reader.namespaces.uri(node, attribute.name.slice(0, colon)) !== R_URI) continue

			const name = target(attribute.value)

			if (name === undefined) return refused("unsupported", `a diagram picture whose relationship ${attribute.value} names no part`)

			editor.setAttribute(node, attribute.name, `${PART_IMAGE_ID}${name}`)
			changed = true
		}
	}

	return changed ? editor.serialize() : undefined
}

// The pending image ids a data part or drawing names, in document order, each once.
export function pendingImageIds(document: XmlDocument): string[] {
	const out = new Set<string>()

	for (let node = 1; node < document.count; node++)
		for (const attribute of document.attributes(node))
			if (attribute.name.endsWith(":embed") || attribute.name.endsWith(":link") || attribute.name.endsWith(":id"))
				if (isPendingImageId(attribute.value)) out.add(attribute.value)

	return [...out]
}

// The bytes with every pending image id replaced by the relationship id `ids` gives it.
export function withImageRelationships(document: XmlDocument, ids: ReadonlyMap<string, string>): Uint8Array {
	const editor = new XmlEditor(document)

	for (let node = 1; node < document.count; node++)
		for (const attribute of document.attributes(node)) {
			const id = ids.get(attribute.value)

			if (id !== undefined && isPendingImageId(attribute.value)) editor.setAttribute(node, attribute.name, id)
		}

	return editor.serialize()
}

// One edit of a data part, as the part's bytes after it (or a typed refusal: an unknown node, a move the tree has no
// room for, a data model past the budgets).
export function editDiagramData(document: XmlDocument, edit: DiagramEdit): DiagramEditResult {
	const model = modelOf(document)

	if ("kind" in model) return model

	const part = new DataPart(document)

	if (part.ptLst < 0) return refused("malformed", "no point list")

	const editor = new XmlEditor(document)

	switch (edit.kind) {
		case "setNodeText":
			return setNodeText(part, editor, edit.node, edit.text)
		case "addNode":
			return addNode(part, editor, model, edit.relativeTo, edit.position, edit.text ?? "", edit.id)
		case "removeNode":
			return removeNode(part, editor, model, edit.node)
		case "promote":
			return promote(part, editor, model, edit.node)
		case "demote":
			return demote(part, editor, model, edit.node)
		case "moveNode":
			return moveNode(part, editor, model, edit.node, edit.direction)
		case "replace":
			return replace(part, editor, edit.matcher, edit.replacement, edit.match)
		case "setDefinition":
			return setDefinition(part, editor, edit.which, edit.uniqueId, edit.category, edit.pictureName)
		case "setPicture":
			return setPicture(part, editor, model, edit)
	}
}

// Whether the data part names relationships of its own (pictures in placeholders): written under a new name, it would
// lose them.
export function dataHasRelationships(document: XmlDocument): boolean {
	return new DataPart(document).hasRelationships()
}

// --- New diagrams ---

export interface DiagramDefinitionIds {
	readonly layout: { readonly uniqueId: string; readonly category?: string | undefined }
	readonly style?: { readonly uniqueId: string; readonly category?: string | undefined } | undefined
	readonly colors?: { readonly uniqueId: string; readonly category?: string | undefined } | undefined
}

// A new data part for Insert ▸ SmartArt: one node per text, its level the text's leading tabs (a level deeper than
// the one before it goes one level deeper), under the doc point.
export function newDiagramData(texts: readonly string[], definitions: DiagramDefinitionIds): string {
	const empty = parseXml(encodeUtf8(`<dgm:dataModel xmlns:dgm="${DGM_URI}" xmlns:a="${A_URI}"><dgm:ptLst/></dgm:dataModel>`))
	const part = new DataPart(empty)
	const ids = new Ids(part, texts.join("\u0000"))
	const docId = ids.take()
	const prSet = (
		[
			["loTypeId", definitions.layout.uniqueId],
			["loCatId", definitions.layout.category],
			["qsTypeId", definitions.style?.uniqueId],
			["qsCatId", definitions.style?.category],
			["csTypeId", definitions.colors?.uniqueId],
			["csCatId", definitions.colors?.category]
		] as const
	)
		.map(([name, value]) => (value === undefined ? "" : ` ${name}="${escapeAttribute(value)}"`))
		.join("")
	let pts = `<dgm:pt modelId="${docId}" type="doc"><dgm:prSet${prSet} phldr="1"/><dgm:spPr/>${newTextXml(part, "")}</dgm:pt>`
	let cxns = ""
	const parents: string[] = [docId]
	const counts = new Map<string, number>()

	for (const raw of texts.slice(0, Math.floor(DEFAULT_SMARTART_BUDGETS.maxPoints / 3) - 1)) {
		const tabs = LEVEL_TABS.exec(raw)?.[0].length ?? 0
		const level = Math.min(tabs + 1, parents.length)
		const parent = parents[level - 1] as string
		const ord = counts.get(parent) ?? 0
		const created = newNodeXml(part, ids, parent, ord, raw.slice(tabs))

		counts.set(parent, ord + 1)
		parents.length = level
		parents.push(created.id)
		pts += created.pts
		cxns += created.cxn
	}

	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<dgm:dataModel xmlns:dgm="${DGM_URI}" xmlns:a="${A_URI}"><dgm:ptLst>${pts}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>`
}

// The uniqueId and first category of a layout, style or colours definition part.
export function definitionIds(document: XmlDocument): { readonly uniqueId: string; readonly category?: string } {
	const reader = drawingReader(document)
	const root = document.documentElement()
	const category = reader.attr(reader.child(reader.child(root, D.Dgm, "catLst"), D.Dgm, "cat"), "type")

	return { uniqueId: reader.attr(root, "uniqueId") ?? "", ...(category === undefined ? {} : { category }) }
}

// --- The drawing written at save ---

// The data part with its drawing cache named: dsp:dataModelExt@relId in the root's extLst (any earlier one dropped).
export function withDrawingReference(document: XmlDocument, relId: string | undefined): Uint8Array {
	const part = new DataPart(document)
	const editor = new XmlEditor(document)
	const reader = part.reader
	const extLst = reader.child(part.root, D.Dgm, "extLst")
	const exts = reader.children(extLst, D.A, "ext")
	const cached = exts.filter(ext => reader.child(ext, D.Dsp, "dataModelExt") >= 0)
	const ext =
		relId === undefined
			? ""
			: `<a:ext xmlns:a="${A_URI}" uri="${DATA_MODEL_EXT_URI}"><dsp:dataModelExt xmlns:dsp="${DSP_URI}" relId="${escapeAttribute(relId)}" minVer="${DGM_URI}"/></a:ext>`

	if (cached.length > 0) {
		// An extLst left empty goes whole.
		if (ext === "" && cached.length === childCount(part.document, extLst)) editor.remove(extLst)
		else
			cached.forEach((node, index) => {
				if (index === 0 && ext !== "") editor.replace(node, ext)
				else editor.remove(node)
			})
	} else if (ext !== "") {
		if (extLst >= 0) editor.append(extLst, ext)
		else editor.append(part.root, `<${part.tag("extLst")}>${ext}</${part.tag("extLst")}>`)
	}

	return editor.serialize()
}

// Laid-out drawings by the data document they were laid out from (the renderer's relayout records each), so the
// writer saves the drawing the user saw. Keyed further by the definitions' parts and the frame's size.
const drawings = new WeakMap<XmlDocument, Map<string, string>>()
const MAX_DRAWINGS_PER_DATA = 4

export function drawingKey(layout: string, style: string, colors: string, w: number, h: number): string {
	return [layout, style, colors, String(Math.round(w)), String(Math.round(h))].join("\u0000")
}

export function rememberDrawing(data: XmlDocument, key: string, drawingXml: string): void {
	let held = drawings.get(data)

	if (held === undefined) {
		held = new Map()
		drawings.set(data, held)
	}

	held.delete(key)
	held.set(key, drawingXml)

	if (held.size > MAX_DRAWINGS_PER_DATA) held.delete(held.keys().next().value as string)
}

export function rememberedDrawing(data: XmlDocument, key: string): string | undefined {
	return drawings.get(data)?.get(key)
}

// --- What the page shows of a diagram ---

export interface SmartArtNodeInfo {
	readonly id: string
	readonly level: number
	readonly type: "node" | "asst"
	readonly text: string
}

export interface SmartArtDefinitionInfo {
	readonly kind: "layout" | "style" | "colors"
	readonly uniqueId: string
	// dgm:title@val (the file's own name for it; may be empty).
	readonly title: string
}

// A diagram as the text pane and the SmartArt tabs show it.
export interface SmartArtInfo {
	// The doc point's modelId: an empty diagram's first node is added below it.
	readonly root: string
	// Depth first in srcOrd order, level 1 under the doc point.
	readonly nodes: readonly SmartArtNodeInfo[]
	// The uniqueIds the doc point names (dgm:prSet loTypeId, qsTypeId, csTypeId), when it names them.
	readonly layout?: string
	readonly style?: string
	readonly colors?: string
	// The definitions the deck's diagrams embed (switchable within this file only).
	readonly deckDefinitions: readonly SmartArtDefinitionInfo[]
	// Where the empty nodes' text goes as last laid out (EMU in the frame): an editor shows its text prompt there (never
	// written, never drawn by the show, thumbnails or exports). Absent before a layout.
	readonly prompts?: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[]
	// The picture placeholders as last laid out (EMU in the frame): the node each belongs to, the layout node's name
	// (what a setPicture op names) and whether a picture fills it. Absent before a layout.
	readonly pictures?: readonly {
		readonly x: number
		readonly y: number
		readonly w: number
		readonly h: number
		readonly node: string
		readonly placeholder: string
		readonly filled: boolean
	}[]
}

// The diagram's outline and definitions; `definitions` are the documents of the deck's diagrams' layout, style and
// colours parts (each listed once by uniqueId).
export function diagramInfo(
	data: XmlDocument,
	definitions: Iterable<{ readonly kind: "layout" | "style" | "colors"; readonly document: XmlDocument }>
): SmartArtInfo | Refused {
	const nodes = diagramOutline(data)

	if ("kind" in nodes) return nodes

	const part = new DataPart(data)
	const doc = part.pts.find(pt => pt.type === "doc")
	const prSet = doc === undefined ? -1 : part.reader.child(doc.node, D.Dgm, "prSet")
	const named = (name: string): string | undefined => {
		const value = prSet < 0 ? undefined : part.reader.attr(prSet, name)

		return value === undefined || value === "" ? undefined : value
	}
	const seen = new Set<string>()
	const deckDefinitions: SmartArtDefinitionInfo[] = []

	for (const { kind, document } of definitions) {
		const reader = drawingReader(document)
		const root = document.documentElement()
		const uniqueId = reader.attr(root, "uniqueId") ?? ""
		const key = `${kind}\u0000${uniqueId}`

		if (uniqueId === "" || seen.has(key)) continue

		seen.add(key)
		deckDefinitions.push({ kind, uniqueId, title: reader.attr(reader.child(root, D.Dgm, "title"), "val") ?? "" })
	}

	const layout = named("loTypeId")
	const style = named("qsTypeId")
	const colors = named("csTypeId")

	return {
		root: doc?.id ?? "",
		nodes,
		...(layout === undefined ? {} : { layout }),
		...(style === undefined ? {} : { style }),
		...(colors === undefined ? {} : { colors }),
		deckDefinitions
	}
}
