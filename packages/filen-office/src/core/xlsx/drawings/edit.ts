import { relativeTarget } from "../../opc/partNames"
import type { SheetId, SheetRefusal } from "../../sheet/protocol"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import { XmlEditor, escapeAttribute, type XmlDocument } from "../../xml/index"
import { freePartName, partFolder } from "../comments/parts"
import type { XlsxDocument } from "../edit/document"
import type { XlsxSheetModel } from "../model/types"
import { childByLocal } from "../refs/markup"
import { namespacesOf, relationshipType } from "../write/namespaces"
import { deleteChartParts } from "../charts/parts"
import { anchorElement, placementMarkup, validAnchor, type DrawingAnchor } from "./anchor"
import { anchorBox, axisPositions } from "./geometry"
import type { DrawingObjectRecord } from "./read"
import { mediaContentType } from "./mediaTypes"
import { DRAWING_TYPE, drawingStore, type DrawingStore } from "./store"
import { DrawingWrites } from "./writes"

// Edits of a sheet's drawing part: an object moved or resized (its anchor, and the frame its own markup records),
// deleted (with the relationships nothing else in the part uses), its alternative text set, and an object appended
// (the part, its relationship and the sheet's <drawing> created when the sheet has none). Every edit writes the
// part's whole bytes through DrawingWrites, so a structure edit afterwards moves what it wrote and an undo puts the
// bytes back.

const XDR = {
	transitional: "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
	strict: "http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing"
}
const MAIN = { transitional: "http://schemas.openxmlformats.org/drawingml/2006/main", strict: "http://purl.oclc.org/ooxml/drawingml/main" }
const CHART = {
	transitional: "http://schemas.openxmlformats.org/drawingml/2006/chart",
	strict: "http://purl.oclc.org/ooxml/drawingml/chart"
}

// Excel's limit on alternative text (the Alt Text pane's).
export const MAX_ALT_TEXT = 4_000

export interface DrawingTarget {
	readonly sheet: SheetId
	readonly model: XlsxSheetModel
	readonly part: string
	readonly store: DrawingStore
}

function refused(refusal: SheetRefusal): { readonly refused: SheetRefusal } {
	return { refused: refusal }
}

// Why drawings cannot be edited on a sheet now.
export function drawingsRefusal(document: XlsxDocument, sheet: SheetId): SheetRefusal | null {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { reason: "unsupported", detail: "sheet" }

	const failure = drawingStore(document.workbook).failure(sheet)

	return failure === null ? null : { reason: "drawingUnavailable", detail: failure }
}

// A sheet ready for a drawing edit: the sheet and its drawing part read, nothing in the way.
async function sheetTarget(
	document: XlsxDocument,
	sheet: SheetId
): Promise<{ model: XlsxSheetModel; part: string; store: DrawingStore } | { refused: SheetRefusal }> {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return refused({ reason: "unsupported", detail: "sheet" })

	const store = drawingStore(document.workbook)

	try {
		await store.load(document, sheet)
	} catch (error) {
		return refused({ reason: "drawingUnavailable", detail: error instanceof Error ? error.message : String(error) })
	}

	const refusal = drawingsRefusal(document, sheet)

	if (refusal !== null) return refused(refusal)

	const model = document.model(sheet)

	if (model === null) return refused({ reason: "unsupported", detail: "sheet" })

	await store.relationshipsOf(entry.part)

	return { model, part: entry.part, store }
}

// The object `key` of the sheet's drawing, when it still is the one the caller saw (`stamp`).
async function objectTarget(
	document: XlsxDocument,
	sheet: SheetId,
	key: number,
	stamp: string
): Promise<{ target: DrawingTarget; document: XmlDocument; object: DrawingObjectRecord } | { refused: SheetRefusal }> {
	const found = await sheetTarget(document, sheet)

	if ("refused" in found) return found

	const drawing = found.store.drawing(sheet)
	const object = drawing?.objects[key]

	if (drawing === null || object === undefined || objectStamp(drawing.document, object) !== stamp)
		return refused({ reason: "unsupported", detail: "object" })

	return { target: { sheet, model: found.model, part: drawing.part, store: found.store }, document: drawing.document, object }
}

// What an object is now, for a caller that names it by its place in z-order: FNV-1a of its markup and its place.
export function objectStamp(document: XmlDocument, object: DrawingObjectRecord): string {
	const bytes = document.raw(object.node)
	let hash = 0x811c9dc5

	for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)

	return `${String(object.key)}:${(hash >>> 0).toString(16)}:${String(bytes.length)}`
}

function prefixOf(document: XmlDocument, node: number): string {
	const prefix = document.prefix(node)

	return prefix === "" ? "" : `${prefix}:`
}

const PLACEMENT: ReadonlySet<string> = new Set(["from", "to", "pos", "ext"])

// The anchors of an object: its own, or one per branch of the mc:AlternateContent around it (each branch places the
// object for its readers, so all move together).
function anchorsOf(document: XmlDocument, object: DrawingObjectRecord): number[] {
	if (object.node === object.anchorNode) return [object.anchorNode]

	const anchors: number[] = []

	for (let branch = document.firstChildElement(object.node); branch >= 0; branch = document.nextSiblingElement(branch))
		for (let child = document.firstChildElement(branch); child >= 0; child = document.nextSiblingElement(child))
			if (document.localName(child).endsWith("Anchor")) anchors.push(child)

	return anchors
}

// The elements an anchor draws: its content past the placement, or each branch's of an mc:AlternateContent there.
function contentsOf(document: XmlDocument, anchor: number): number[] {
	for (let child = document.firstChildElement(anchor); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (PLACEMENT.has(local) || local === "clientData") continue
		if (local !== "AlternateContent") return [child]

		const contents: number[] = []

		for (let branch = document.firstChildElement(child); branch >= 0; branch = document.nextSiblingElement(branch)) {
			const first = document.firstChildElement(branch)

			if (first >= 0) contents.push(first)
		}

		return contents
	}

	return []
}

// An anchor's placement written again and the frames its content records (a:xfrm under spPr or grpSpPr, xdr:xfrm of
// a graphic frame) set to `box`, as Excel writes them. False when the anchor has no placement to replace.
function placeAnchor(
	document: XmlDocument,
	editor: XmlEditor,
	anchorNode: number,
	anchor: DrawingAnchor,
	box: { x: number; y: number; cx: number; cy: number }
): boolean {
	const placement: number[] = []

	for (let child = document.firstChildElement(anchorNode); child >= 0; child = document.nextSiblingElement(child))
		if (PLACEMENT.has(document.localName(child))) placement.push(child)

	const first = placement[0]

	if (first === undefined) return false

	editor.replace(first, placementMarkup(prefixOf(document, anchorNode), anchor))

	for (const node of placement.slice(1)) editor.remove(node)

	for (const content of contentsOf(document, anchorNode)) {
		const local = document.localName(content)
		const properties = local === "graphicFrame" ? content : childByLocal(document, content, local === "grpSp" ? "grpSpPr" : "spPr")
		const xfrm = properties < 0 ? -1 : childByLocal(document, properties, "xfrm")
		const off = xfrm < 0 ? -1 : childByLocal(document, xfrm, "off")
		const ext = xfrm < 0 ? -1 : childByLocal(document, xfrm, "ext")

		if (off >= 0) {
			editor.setAttribute(off, "x", String(box.x))
			editor.setAttribute(off, "y", String(box.y))
		}

		if (ext >= 0) {
			editor.setAttribute(ext, "cx", String(box.cx))
			editor.setAttribute(ext, "cy", String(box.cy))
		}
	}

	return true
}

function report(sheet: SheetId): (changes: SheetChangeSink) => void {
	return changes => {
		changes.layout(sheet)
	}
}

// An object moved or resized: its anchor's placement written again (the anchor keeps its kind and editAs).
export async function moveObject(
	document: XlsxDocument,
	sheet: SheetId,
	key: number,
	stamp: string,
	anchor: DrawingAnchor,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (!validAnchor(anchor)) return refused({ reason: "tooLarge", detail: "object" })

	const found = await objectTarget(document, sheet, key, stamp)

	if ("refused" in found) return found

	const { target, object } = found
	const xml = found.document
	const current = object.anchor

	if (current === null || current.mode !== anchor.mode) return refused({ reason: "unsupported", detail: "anchor" })
	if (anchor.mode === "twoCell" && current.mode === "twoCell" && anchor.editAs !== current.editAs)
		return refused({ reason: "unsupported", detail: "anchor" })

	const layout = document.layout(sheet)
	const rows = axisPositions(layout.rows)
	const cols = axisPositions(layout.cols)
	const box = anchorBox(anchor, rows, cols)
	const was = anchorBox(current, rows, cols)

	// The file's locks (a:picLocks noMove, noResize...), as Excel keeps them.
	if ((object.noMove && (box.x !== was.x || box.y !== was.y)) || (object.noResize && (box.cx !== was.cx || box.cy !== was.cy)))
		return refused({ reason: "objectLocked" })

	const editor = new XmlEditor(xml)
	const anchors = anchorsOf(xml, object)

	// Every branch's anchor takes the same placement; one without a placement to replace refuses the move.
	if (anchors.length === 0 || anchors.some(node => xml.localName(node) !== xml.localName(object.anchorNode)))
		return refused({ reason: "unsupported", detail: "anchor" })

	for (const node of anchors)
		if (!placeAnchor(xml, editor, node, anchor, box)) return refused({ reason: "unsupported", detail: "anchor" })

	const writes = new DrawingWrites(document.workbook)

	writes.setPart(target.part, DRAWING_TYPE, editor.serialize())

	const tell = report(sheet)

	tell(changes)

	return writes.step(tell)
}

// Objects deleted, with the relationships only they used: a chart's parts go with its frame, and a picture this
// session added goes from the package.
export async function deleteObjects(
	document: XlsxDocument,
	sheet: SheetId,
	objects: readonly { readonly key: number; readonly stamp: string }[],
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const found = await sheetTarget(document, sheet)

	if ("refused" in found) return found

	const drawing = found.store.drawing(sheet)

	if (drawing === null) return null

	const removed = new Set<number>()

	for (const { key, stamp } of objects) {
		const object = drawing.objects[key]

		if (object === undefined || objectStamp(drawing.document, object) !== stamp)
			return refused({ reason: "unsupported", detail: "object" })

		removed.add(key)
	}

	if (removed.size === 0) return null

	const editor = new XmlEditor(drawing.document)
	const kept = new Set<string>()
	const dropped = new Set<string>()

	for (const object of drawing.objects) {
		if (removed.has(object.key)) {
			editor.remove(object.node)

			for (const id of object.relationships) dropped.add(id)
		} else {
			for (const id of object.relationships) kept.add(id)
		}
	}

	const writes = new DrawingWrites(document.workbook)
	const relationships = found.store.relationships(drawing.part)

	writes.setPart(drawing.part, DRAWING_TYPE, editor.serialize())

	for (const id of dropped) {
		if (kept.has(id)) continue

		const relationship = relationships.find(candidate => candidate.id === id)

		if (relationship === undefined) continue

		writes.removeRelationship(drawing.part, id)

		const target = relationship.external ? undefined : relationship.partName

		if (target === undefined) continue

		const kind = relationship.type.slice(relationship.type.lastIndexOf("/") + 1)

		if (kind === "chart" || kind === "chartEx") await deleteChartParts(document, writes, target)
		// A picture this session added has no other owner: it leaves the package with its last object.
		else if (kind === "image" && document.workbook.parts.get(target) === undefined && found.store.bytes(target) !== undefined)
			writes.removePart(target, mediaContentType(target))
	}

	const tell = report(sheet)

	tell(changes)

	return writes.step(tell)
}

// An object's alternative text (descr) set in every branch naming it; "" removes it.
export async function setAltText(
	document: XlsxDocument,
	sheet: SheetId,
	key: number,
	stamp: string,
	alt: string,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (alt.length > MAX_ALT_TEXT) return refused({ reason: "tooLarge", detail: "alt" })

	const found = await objectTarget(document, sheet, key, stamp)

	if ("refused" in found) return found

	const { object } = found
	const xml = found.document

	if (object.properties.length === 0) return refused({ reason: "unsupported", detail: "object" })
	if (object.properties.every(node => (xml.attribute(node, "descr") ?? "") === alt)) return null

	const editor = new XmlEditor(xml)

	for (const node of object.properties) {
		if (alt === "") editor.removeAttribute(node, "descr")
		else editor.setAttribute(node, "descr", alt)
	}

	const writes = new DrawingWrites(document.workbook)

	writes.setPart(found.target.part, DRAWING_TYPE, editor.serialize())

	const tell = report(sheet)

	tell(changes)

	return writes.step(tell)
}

// The next cNvPr id free in a part (unique within it, §20.1.2.2.8).
export function nextShapeId(document: XmlDocument | null): number {
	let highest = 0

	if (document === null) return 1

	const walk = (node: number): void => {
		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "cNvPr") highest = Math.max(highest, Number(document.attribute(child, "id") ?? 0) || 0)

			walk(child)
		}
	}

	walk(document.documentElement())

	return highest + 1
}

export interface AppendedObject {
	readonly drawingPart: string
	readonly key: number
}

// An object appended to the sheet's drawing (on top of the others): `markup` writes its element (xdr:pic,
// xdr:graphicFrame...) with the prefixes xdr, a, r and c, which the anchor declares; `relate` adds a relationship from
// the drawing part and gives its id. `id` is a cNvPr id free in the part. Creates the part, its relationship and the
// sheet's <drawing> when the sheet has none.
export async function appendDrawingObject(
	document: XlsxDocument,
	sheet: SheetId,
	writes: DrawingWrites,
	anchor: DrawingAnchor,
	markup: (relate: (type: string, targetPart: string) => string, id: number) => string
): Promise<AppendedObject | { readonly refused: SheetRefusal }> {
	if (!validAnchor(anchor)) return refused({ reason: "tooLarge", detail: "object" })

	const found = await sheetTarget(document, sheet)

	if ("refused" in found) return found

	const workbook = document.workbook
	const strict = workbook.strict
	const store = found.store
	const existing = store.drawing(sheet)
	let part = existing?.part ?? store.part(sheet)?.name ?? null

	// A <drawing> whose part is gone or never was cannot take objects.
	if (existing === null && part !== null) return refused({ reason: "drawingUnavailable", detail: part })

	const xdr = existing === null ? (strict ? XDR.strict : XDR.transitional) : (drawingRootUri(existing.document) ?? XDR.transitional)
	const purl = xdr === XDR.strict
	const relationshipsUri = namespacesOf(purl).relationships
	const declarations =
		`xmlns:xdr="${xdr}" xmlns:a="${purl ? MAIN.strict : MAIN.transitional}" ` +
		`xmlns:r="${relationshipsUri}" xmlns:c="${purl ? CHART.strict : CHART.transitional}"`

	if (part === null) {
		const name = freePartName(workbook, n => `${partFolder(workbook)}drawings/drawing${String(n)}.xml`)

		await store.relationshipsOf(name)

		const relationship = writes.addRelationship(found.part, {
			type: relationshipType(strict, "drawing"),
			target: relativeTarget(found.part, name)
		})
		const prefix = found.model.prefix
		const p = prefix === "" ? "" : `${prefix}:`

		writes.setSection(found.model, "drawing", [
			`<${p}drawing xmlns:r="${namespacesOf(strict).relationships}" r:id="${escapeAttribute(relationship.id)}"/>`
		])
		part = name
	} else {
		await store.relationshipsOf(part)
	}

	const drawingPart = part
	const relate = (type: string, targetPart: string): string =>
		writes.addRelationship(drawingPart, { type, target: relativeTarget(drawingPart, targetPart) }).id
	const element = anchorElement(anchor)
	const editAs = anchor.mode === "twoCell" && anchor.editAs !== "twoCell" ? ` editAs="${anchor.editAs}"` : ""
	const object =
		`<xdr:${element} ${declarations}${editAs}>${placementMarkup("xdr:", anchor)}` +
		`${markup(relate, nextShapeId(existing?.document ?? null))}<xdr:clientData/></xdr:${element}>`

	if (existing === null) {
		writes.setPart(
			drawingPart,
			DRAWING_TYPE,
			new TextEncoder().encode(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${xdr}" xmlns:a="${purl ? MAIN.strict : MAIN.transitional}">${object}</xdr:wsDr>`
			)
		)

		return { drawingPart, key: 0 }
	}

	const editor = new XmlEditor(existing.document)

	editor.append(existing.root, object)
	writes.setPart(drawingPart, DRAWING_TYPE, editor.serialize())

	return { drawingPart, key: existing.objects.length }
}

function drawingRootUri(document: XmlDocument): string | undefined {
	const root = document.documentElement()
	const prefix = document.prefix(root)
	const declared = document.attribute(root, prefix === "" ? "xmlns" : `xmlns:${prefix}`)

	return declared === XDR.strict || declared === XDR.transitional ? declared : undefined
}
