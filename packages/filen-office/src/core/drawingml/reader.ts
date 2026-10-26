import { Namespaces, NodeKind, type XmlDocument } from "../xml/index"

// Namespace groups the drawing layer reads. Transitional and Strict URIs share a group, so elements are
// compared as (group, local name), never by prefix.
export const D = {
	None: 0,
	A: 1,
	C: 2,
	Dsp: 3,
	Pic: 4,
	Wps: 5,
	Wpg: 6,
	Wpc: 7,
	R: 8,
	MC: 9,
	A14: 10,
	Asvg: 11,
	Dgm: 12,
	Cx: 13,
	W: 14,
	V: 15,
	O: 16,
	W10: 17,
	C14: 18,
	Cdr: 19,
	Lc: 20,
	Wp: 21,
	Xdr: 22,
	// PresentationML and the PowerPoint 2010, 2013 and 2015 extensions.
	P: 23,
	P14: 24,
	P15: 25,
	P159: 26
} as const

export type D = (typeof D)[keyof typeof D]

const GROUP_URIS: readonly (readonly [D, readonly string[]])[] = [
	[D.A, ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"]],
	[D.C, ["http://schemas.openxmlformats.org/drawingml/2006/chart", "http://purl.oclc.org/ooxml/drawingml/chart"]],
	[D.Dsp, ["http://schemas.microsoft.com/office/drawing/2008/diagram"]],
	[D.Pic, ["http://schemas.openxmlformats.org/drawingml/2006/picture", "http://purl.oclc.org/ooxml/drawingml/picture"]],
	[D.Wps, ["http://schemas.microsoft.com/office/word/2010/wordprocessingShape"]],
	[D.Wpg, ["http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"]],
	[D.Wpc, ["http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"]],
	[
		D.R,
		["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"]
	],
	[D.MC, ["http://schemas.openxmlformats.org/markup-compatibility/2006"]],
	[D.A14, ["http://schemas.microsoft.com/office/drawing/2010/main"]],
	[D.Asvg, ["http://schemas.microsoft.com/office/drawing/2016/SVG/main"]],
	[D.Dgm, ["http://schemas.openxmlformats.org/drawingml/2006/diagram", "http://purl.oclc.org/ooxml/drawingml/diagram"]],
	[D.Cx, ["http://schemas.microsoft.com/office/drawing/2014/chartex"]],
	[D.W, ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]],
	[D.V, ["urn:schemas-microsoft-com:vml"]],
	[D.O, ["urn:schemas-microsoft-com:office:office"]],
	[D.W10, ["urn:schemas-microsoft-com:office:word"]],
	[D.C14, ["http://schemas.microsoft.com/office/drawing/2007/8/2/chart"]],
	[D.Cdr, ["http://schemas.openxmlformats.org/drawingml/2006/chartDrawing", "http://purl.oclc.org/ooxml/drawingml/chartDrawing"]],
	[D.Lc, ["http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas", "http://purl.oclc.org/ooxml/drawingml/lockedCanvas"]],
	[
		D.Wp,
		[
			"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
			"http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing"
		]
	],
	[
		D.Xdr,
		["http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing", "http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing"]
	],
	[D.P, ["http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"]],
	[D.P14, ["http://schemas.microsoft.com/office/powerpoint/2010/main"]],
	[D.P15, ["http://schemas.microsoft.com/office/powerpoint/2012/main"]],
	[D.P159, ["http://schemas.microsoft.com/office/powerpoint/2015/09/main"]]
]

const GROUP_BY_URI = new Map<string, D>()

for (const [group, uris] of GROUP_URIS) {
	for (const uri of uris) GROUP_BY_URI.set(uri, group)
}

const URIS_BY_GROUP: readonly ReadonlySet<string>[] = (() => {
	const out: Set<string>[] = []

	for (const [group, uris] of GROUP_URIS) out[group] = new Set(uris)

	return out
})()

export function drawingGroupOf(uri: string | undefined): D {
	return uri === undefined ? D.None : (GROUP_BY_URI.get(uri) ?? D.None)
}

export function groupUris(group: D): ReadonlySet<string> {
	return URIS_BY_GROUP[group] ?? new Set()
}

const UNSET = -2

const shared = new WeakMap<XmlDocument, DrawingReader>()

// The reader shared by every drawing conversion of one part. A host that already resolved the part's
// namespaces (the docx model) passes them, so the part is not scanned twice.
export function drawingReader(document: XmlDocument, namespaces?: Namespaces): DrawingReader {
	let reader = shared.get(document)

	if (reader === undefined) {
		reader = new DrawingReader(document, namespaces)
		shared.set(document, reader)
	}

	return reader
}

// EMU per unit of an ST_UniversalMeasure suffix.
const EMU_PER_UNIT: Readonly<Record<string, number>> = { in: 914400, cm: 360000, mm: 36000, pt: 12700, pc: 152400, pi: 152400 }

// Element classification and lenient attribute reads over one part. Nothing here throws on malformed
// markup: an unreadable attribute reads as absent.
export class DrawingReader {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	private readonly groupByName: Int8Array
	private readonly flat: boolean

	constructor(document: XmlDocument, namespaces: Namespaces = new Namespaces(document, { lenient: true })) {
		this.document = document
		this.namespaces = namespaces

		const root = document.documentElement()
		let flat = true

		for (const node of this.namespaces.declarations().keys()) {
			if (node !== root) {
				flat = false

				break
			}
		}

		this.flat = flat
		this.groupByName = new Int8Array(document.names.length).fill(UNSET)
	}

	group(node: number): D {
		const document = this.document

		if (document.kinds[node] !== NodeKind.Element) return D.None

		const id = document.nameIds[node] ?? 0

		if (this.flat) {
			const cached = this.groupByName[id] ?? UNSET

			if (cached !== UNSET) return cached as D
		}

		const group = drawingGroupOf(this.namespaces.elementUri(node))

		if (this.flat) this.groupByName[id] = group

		return group
	}

	local(node: number): string {
		return this.document.localName(node)
	}

	is(node: number, group: D, local: string): boolean {
		return this.group(node) === group && this.document.localName(node) === local
	}

	// First child element {group}local, or -1.
	child(node: number, group: D, local: string): number {
		if (node < 0) return -1

		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.is(child, group, local)) return child
		}

		return -1
	}

	// Every child element {group}local.
	children(node: number, group: D, local: string): number[] {
		const out: number[] = []

		if (node < 0) return out

		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.is(child, group, local)) out.push(child)
		}

		return out
	}

	// The first child element in `group` whose local name is one of `locals`, or -1.
	childOf(node: number, group: D, locals: ReadonlySet<string>): number {
		if (node < 0) return -1

		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.group(child) === group && locals.has(document.localName(child))) return child
		}

		return -1
	}

	// First descendant {group}local in document order, or -1.
	descendant(node: number, group: D, local: string): number {
		if (node < 0) return -1

		const document = this.document
		const end = document.end(node)

		for (let n = node + 1; n < document.count && document.start(n) < end; n++) {
			if (document.kinds[n] === NodeKind.Element && this.is(n, group, local)) return n
		}

		return -1
	}

	// An unprefixed attribute, or undefined (also when the start tag cannot be read).
	attr(node: number, local: string): string | undefined {
		if (node < 0) return undefined

		try {
			return this.document.attribute(node, local)
		} catch {
			return undefined
		}
	}

	// A namespaced attribute ({group}local) under any prefix bound to the group at `node`.
	attrNs(node: number, group: D, local: string): string | undefined {
		if (node < 0) return undefined

		const uris = groupUris(group)

		for (const [prefix, uri] of this.namespaces.inScope(node)) {
			if (prefix === "" || !uris.has(uri)) continue

			const value = this.attr(node, `${prefix}:${local}`)

			if (value !== undefined) return value
		}

		return undefined
	}

	// A decimal attribute, or `fallback`.
	number(node: number, local: string, fallback: number): number {
		const text = this.attr(node, local)

		if (text === undefined) return fallback

		const value = Number(text.trim())

		return text.trim() !== "" && Number.isFinite(value) ? value : fallback
	}

	// ST_Boolean: "1"/"true"/"on" (and "t" as VML writes it).
	bool(node: number, local: string, fallback: boolean): boolean {
		const text = this.attr(node, local)

		if (text === undefined) return fallback

		const value = text.trim().toLowerCase()

		return value === "1" || value === "true" || value === "on" || value === "t"
	}

	// ST_Percentage and friends as a fraction: "50000" (thousandths of a percent) or "50%" (Strict).
	fraction(node: number, local: string, fallback: number): number {
		const text = this.attr(node, local)

		return text === undefined ? fallback : parseFraction(text, fallback)
	}

	// ST_Angle (60000ths of a degree) in degrees.
	angle(node: number, local: string, fallback: number): number {
		const value = this.number(node, local, Number.NaN)

		return Number.isNaN(value) ? fallback : value / 60000
	}

	// ST_Coordinate in EMU: a number, or a universal measure ("1in", "2.5cm").
	emu(node: number, local: string, fallback: number): number {
		const text = this.attr(node, local)

		return text === undefined ? fallback : parseEmu(text, fallback)
	}

	// The element's text, or "" (lenient).
	text(node: number): string {
		if (node < 0) return ""

		try {
			return this.document.textContent(node)
		} catch {
			return ""
		}
	}
}

export function parseFraction(text: string, fallback: number): number {
	const trimmed = text.trim()
	const value = Number.parseFloat(trimmed)

	if (!Number.isFinite(value)) return fallback

	return trimmed.endsWith("%") ? value / 100 : value / 100000
}

// The range of ST_Coordinate (§20.1.10.16); values outside it are clamped.
export const MAX_COORDINATE = 27273042316900

function clampCoordinate(value: number): number {
	return value > MAX_COORDINATE ? MAX_COORDINATE : value < -MAX_COORDINATE ? -MAX_COORDINATE : value
}

export function parseEmu(text: string, fallback: number): number {
	const trimmed = text.trim()
	const plain = Number(trimmed)

	if (trimmed !== "" && Number.isFinite(plain)) return clampCoordinate(plain)

	const match = /^(-?[0-9]*\.?[0-9]+)(in|cm|mm|pt|pc|pi)$/.exec(trimmed)

	if (match === null) return fallback

	const value = Number.parseFloat(match[1] ?? "0") * (EMU_PER_UNIT[match[2] ?? ""] ?? 0)

	return Number.isFinite(value) ? clampCoordinate(value) : fallback
}

export const EMU_PER_PX = 9525
export const EMU_PER_PT = 12700

export function emuToPx(emu: number): number {
	return emu / EMU_PER_PX
}
