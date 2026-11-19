import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { encodeUtf8, XmlEditor, type XmlDocument } from "../../xml/index"
import { cellKeyOf } from "../edit/history"
import { rootPrefix } from "./notes"

// A sheet's legacy drawing (VML, ECMA-376 Part 4 §14; [MS-OI29500] §2.1.1716): each note has a shape there,
// x:ClientData ObjectType="Note" naming its cell (x:Row, x:Column, 0-based) and whether it is shown all the time
// (x:Visible). Form controls share the part; only note shapes are touched. Shape ids come from the part's id blocks
// (o:idmap data: block n holds ids n * 1024 to n * 1024 + 1023), which are unique in the workbook.

export const VML_NAMESPACE = "urn:schemas-microsoft-com:vml"
export const OFFICE_NAMESPACE = "urn:schemas-microsoft-com:office:office"
export const EXCEL_NAMESPACE = "urn:schemas-microsoft-com:office:excel"

const BLOCK = 1024
// The text box shape type Excel's notes use (§14.1.2.20, o:spt 202).
const NOTE_SHAPE_TYPE = "_x0000_t202"

export interface NoteShape {
	readonly node: number
	readonly clientData: number
	readonly shown: boolean
}

export interface VmlPart {
	readonly document: XmlDocument
	// Prefixes the root binds (with their colons), null for a namespace it does not bind.
	readonly v: string | null
	readonly o: string | null
	readonly x: string | null
	// Note shapes by cellKeyOf.
	readonly notes: ReadonlyMap<number, NoteShape>
	// The id blocks the part's o:idmap names, and its node (-1: none).
	readonly blocks: readonly number[]
	readonly idmap: number
	// Shape ids in use (_x0000_s<n>).
	readonly ids: ReadonlySet<number>
	readonly shapeCount: number
	readonly noteType: boolean
}

function elements(document: XmlDocument, node: number, visit: (node: number) => void): void {
	visit(node)

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		elements(document, child, visit)
}

function withColon(prefix: string | null): string | null {
	return prefix === null ? null : prefix === "" ? "" : `${prefix}:`
}

export function idBlocks(text: string): number[] {
	return text
		.split(",")
		.map(block => Number(block.trim()))
		.filter(block => Number.isInteger(block) && block > 0)
}

export function readVml(document: XmlDocument): VmlPart {
	const notes = new Map<number, NoteShape>()
	const ids = new Set<number>()
	let blocks: number[] = []
	let idmap = -1
	let shapeCount = 0
	let noteType = false

	elements(document, document.documentElement(), node => {
		const local = document.localName(node)

		if (local === "idmap" && idmap < 0) {
			idmap = node
			blocks = idBlocks(document.attribute(node, "data") ?? "")
		} else if (local === "shapetype") {
			if (document.attribute(node, "id") === NOTE_SHAPE_TYPE) noteType = true
		} else if (local === "shape") {
			shapeCount++

			// Excel keeps the id in o:spid when it writes id itself as "_x005f_x0000_s-1" (workbooks with threads).
			for (const attribute of document.attributes(node)) {
				const name = attribute.name.slice(attribute.name.indexOf(":") + 1)
				const id = name === "id" || name === "spid" ? /^_x0000_s(\d+)$/.exec(attribute.value)?.[1] : undefined

				if (id !== undefined) ids.add(Number(id))
			}
		} else if (local === "ClientData" && document.attribute(node, "ObjectType") === "Note") {
			let row = -1
			let col = -1
			let shown = false

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const name = document.localName(child)

				if (name === "Row") row = Number(document.textContent(child).trim())
				else if (name === "Column") col = Number(document.textContent(child).trim())
				else if (name === "Visible") {
					// A true/false/blank value: blank or true shows the note, anything else hides it.
					const value = document.textContent(child).trim().toLowerCase()

					shown = value === "" || value === "true" || value === "t"
				}
			}

			if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < SHEET_MAX_ROWS && col < SHEET_MAX_COLS) {
				const key = cellKeyOf(row, col)

				if (!notes.has(key)) notes.set(key, { node: document.parent(node), clientData: node, shown })
			}
		}
	})

	return {
		document,
		v: withColon(rootPrefix(document, VML_NAMESPACE)),
		o: withColon(rootPrefix(document, OFFICE_NAMESPACE)),
		x: withColon(rootPrefix(document, EXCEL_NAMESPACE)),
		notes,
		blocks,
		idmap,
		ids,
		shapeCount,
		noteType
	}
}

// Where a note's box goes as Excel places a new one: right of the cell, from the row above it, two columns wide and
// four rows tall ("LeftColumn, LeftOffset, TopRow, TopOffset, RightColumn, RightOffset, BottomRow, BottomOffset").
export function noteAnchor(row: number, col: number): string {
	const left = Math.min(col + 1, SHEET_MAX_COLS - 1)
	const right = Math.min(col + 3, SHEET_MAX_COLS - 1)
	const top = Math.max(0, Math.min(row - 1, SHEET_MAX_ROWS - 5))

	return `${String(left)}, 15, ${String(top)}, ${row === 0 ? "2" : "10"}, ${String(right)}, 31, ${String(top + 4)}, 9`
}

interface Prefixes {
	readonly v: string
	readonly o: string
	readonly x: string
	// Declarations a shape needs for the namespaces the root does not bind.
	readonly declarations: string
}

function prefixes(part: VmlPart | null): Prefixes {
	let declarations = ""

	if (part !== null && part.v === null) declarations += ` xmlns:v="${VML_NAMESPACE}"`
	if (part !== null && part.o === null) declarations += ` xmlns:o="${OFFICE_NAMESPACE}"`
	if (part !== null && part.x === null) declarations += ` xmlns:x="${EXCEL_NAMESPACE}"`

	return { v: part?.v ?? "v:", o: part?.o ?? "o:", x: part?.x ?? "x:", declarations }
}

function shapeTypeMarkup(p: Prefixes): string {
	return (
		`<${p.v}shapetype id="${NOTE_SHAPE_TYPE}" coordsize="21600,21600" ${p.o}spt="202" path="m,l,21600r21600,l21600,xe"${p.declarations}>` +
		`<${p.v}stroke joinstyle="miter"/><${p.v}path gradientshapeok="t" ${p.o}connecttype="rect"/></${p.v}shapetype>`
	)
}

// A note's shape, as Excel writes one (hidden unless shown).
export function noteShapeMarkup(p: Prefixes, id: number, z: number, row: number, col: number, shown: boolean): string {
	return (
		`<${p.v}shape id="_x0000_s${String(id)}" type="#${NOTE_SHAPE_TYPE}" ` +
		`style="position:absolute;width:108pt;height:59.25pt;z-index:${String(z)};visibility:${shown ? "visible" : "hidden"}" ` +
		`fillcolor="infoBackground [80]" strokecolor="none [81]" ${p.o}insetmode="auto"${p.declarations}>` +
		`<${p.v}fill color2="infoBackground [80]"/><${p.v}shadow color="none [81]" obscured="t"/><${p.v}path ${p.o}connecttype="none"/>` +
		`<${p.v}textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></${p.v}textbox>` +
		`<${p.x}ClientData ObjectType="Note"><${p.x}MoveWithCells/><${p.x}SizeWithCells/><${p.x}Anchor>${noteAnchor(row, col)}</${p.x}Anchor>` +
		`<${p.x}AutoFill>False</${p.x}AutoFill><${p.x}Row>${String(row)}</${p.x}Row><${p.x}Column>${String(col)}</${p.x}Column>` +
		`${shown ? `<${p.x}Visible/>` : ""}</${p.x}ClientData></${p.v}shape>`
	)
}

// A legacy drawing of its own for a sheet's first note shapes, with id block `block`.
export function newVml(block: number, cells: readonly { readonly row: number; readonly col: number }[]): Uint8Array {
	const p = prefixes(null)
	const shapes = cells.map((cell, k) => noteShapeMarkup(p, block * BLOCK + 1 + k, k + 1, cell.row, cell.col, false)).join("")

	return encodeUtf8(
		`<xml xmlns:v="${VML_NAMESPACE}" xmlns:o="${OFFICE_NAMESPACE}" xmlns:x="${EXCEL_NAMESPACE}">` +
			`<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${String(block)}"/></o:shapelayout>` +
			`${shapeTypeMarkup(p)}${shapes}</xml>`
	)
}

// The free shape ids of a part's blocks, `count` of them; null when its blocks are too full (another block is then
// needed: extendVml).
function freeIds(part: VmlPart, blocks: readonly number[], count: number): number[] | null {
	const out: number[] = []

	for (const block of blocks) {
		for (let id = block * BLOCK + 1; id < (block + 1) * BLOCK && out.length < count; id++) if (!part.ids.has(id)) out.push(id)

		if (out.length === count) return out
	}

	return null
}

// Shapes for notes on `cells` added to a part. `spare`: a block no other part uses, added to the part's idmap when its
// own blocks are full. Null when they cannot get ids (a part without an idmap, or a full one with no spare).
export function addNoteShapes(
	part: VmlPart,
	cells: readonly { readonly row: number; readonly col: number }[],
	spare: number | null
): Uint8Array | null {
	if (part.idmap < 0) return null

	const editor = new XmlEditor(part.document)
	let blocks = part.blocks
	let ids = freeIds(part, blocks, cells.length)

	if (ids === null) {
		if (spare === null) return null

		blocks = [...blocks, spare]
		ids = freeIds(part, blocks, cells.length)

		if (ids === null) return null

		editor.setAttribute(part.idmap, "data", blocks.join(","))
	}

	const p = prefixes(part)
	const root = part.document.documentElement()
	let markup = part.noteType ? "" : shapeTypeMarkup(p)

	cells.forEach((cell, k) => {
		markup += noteShapeMarkup(p, ids[k] ?? 0, part.shapeCount + k + 1, cell.row, cell.col, false)
	})

	editor.append(root, markup)

	return editor.serialize()
}

export function removeNoteShapes(part: VmlPart, keys: ReadonlySet<number>): Uint8Array {
	const editor = new XmlEditor(part.document)

	for (const [key, shape] of part.notes) if (keys.has(key)) editor.remove(shape.node)

	return editor.serialize()
}

// A note shown all the time or only on hover: x:Visible, and the shape's visibility style.
export function showNoteShape(part: VmlPart, key: number, shown: boolean): Uint8Array | null {
	const shape = part.notes.get(key)

	if (shape === undefined) return null
	if (shape.shown === shown) return null

	const { document } = part
	const editor = new XmlEditor(document)
	const style = document.attribute(shape.node, "style") ?? ""
	const visibility = `visibility:${shown ? "visible" : "hidden"}`
	const restyled = /visibility\s*:\s*\w+/i.test(style)
		? style.replace(/visibility\s*:\s*\w+/i, visibility)
		: `${style}${style === "" || style.trimEnd().endsWith(";") ? "" : ";"}${visibility}`

	editor.setAttribute(shape.node, "style", restyled)

	if (shown) {
		const name = document.name(shape.clientData)
		const colon = name.indexOf(":")
		const visible = `<${colon < 0 ? "" : name.slice(0, colon + 1)}Visible/>`
		let replaced = false

		// A false-valued x:Visible becomes the empty element instead of gaining a second one beside it.
		for (let child = document.firstChildElement(shape.clientData); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "Visible") continue

			if (replaced) {
				editor.remove(child)
			} else {
				editor.replace(child, visible)
				replaced = true
			}
		}

		if (!replaced) editor.append(shape.clientData, visible)
	} else {
		for (let child = document.firstChildElement(shape.clientData); child >= 0; child = document.nextSiblingElement(child))
			if (document.localName(child) === "Visible") editor.remove(child)
	}

	return editor.serialize()
}
