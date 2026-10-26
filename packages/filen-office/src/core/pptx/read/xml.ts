import { parseEmu, parseFraction } from "../../drawingml/reader"
import { MC_NAMESPACE, Namespaces, NodeKind, selectAlternateContent, type XmlDocument } from "../../xml/index"

// Element classification and lenient attribute reads over one PresentationML part. Transitional and Strict URIs
// share a group, so elements compare as (group, local name), never by prefix. Nothing here throws on malformed
// markup: an unreadable attribute reads as absent, and the part is flagged (`malformed`).

export const G = {
	None: 0,
	P: 1,
	A: 2,
	R: 3,
	MC: 4,
	P14: 5,
	P15: 6,
	A14: 7,
	A16: 8,
	Adec: 9,
	Dgm: 10,
	C: 11,
	Cx: 12,
	Asvg: 13,
	P188: 14,
	P159: 15,
	Pic: 16,
	Dsp: 17,
	Other: 18
} as const

export type G = (typeof G)[keyof typeof G]

export const STRICT_P = "http://purl.oclc.org/ooxml/presentationml/main"
export const P_MAIN = "http://schemas.openxmlformats.org/presentationml/2006/main"

const GROUPS: readonly (readonly [G, readonly string[]])[] = [
	[G.P, [P_MAIN, STRICT_P]],
	[G.A, ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"]],
	[
		G.R,
		["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"]
	],
	[G.MC, [MC_NAMESPACE]],
	[G.P14, ["http://schemas.microsoft.com/office/powerpoint/2010/main"]],
	[G.P15, ["http://schemas.microsoft.com/office/powerpoint/2012/main"]],
	[G.A14, ["http://schemas.microsoft.com/office/drawing/2010/main"]],
	[G.A16, ["http://schemas.microsoft.com/office/drawing/2014/main"]],
	[G.Adec, ["http://schemas.microsoft.com/office/drawing/2017/decorative"]],
	[G.Dgm, ["http://schemas.openxmlformats.org/drawingml/2006/diagram", "http://purl.oclc.org/ooxml/drawingml/diagram"]],
	[G.C, ["http://schemas.openxmlformats.org/drawingml/2006/chart", "http://purl.oclc.org/ooxml/drawingml/chart"]],
	[G.Cx, ["http://schemas.microsoft.com/office/drawing/2014/chartex"]],
	[G.Asvg, ["http://schemas.microsoft.com/office/drawing/2016/SVG/main"]],
	[G.P188, ["http://schemas.microsoft.com/office/powerpoint/2018/8/main"]],
	[G.P159, ["http://schemas.microsoft.com/office/powerpoint/2015/09/main"]],
	[G.Pic, ["http://schemas.openxmlformats.org/drawingml/2006/picture", "http://purl.oclc.org/ooxml/drawingml/picture"]],
	[G.Dsp, ["http://schemas.microsoft.com/office/drawing/2008/diagram"]]
]

const GROUP_BY_URI = new Map<string, G>()

for (const [group, uris] of GROUPS) for (const uri of uris) GROUP_BY_URI.set(uri, group)

export function groupOf(uri: string | undefined): G {
	return uri === undefined ? G.None : (GROUP_BY_URI.get(uri) ?? G.Other)
}

// The mc:Choice namespaces whose content we read (everything else takes the Fallback).
const UNDERSTOOD = new Set<string>(
	[G.P, G.A, G.R, G.P14, G.P15, G.P159, G.A14, G.A16, G.Adec, G.Dsp, G.C, G.Dgm, G.Pic].flatMap(
		group => GROUPS.find(([g]) => g === group)?.[1] ?? []
	)
)

export function understood(uri: string): boolean {
	return UNDERSTOOD.has(uri)
}

const UNSET = -1

export class PartReader {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	// A start tag that could not be read: the part is view-only (gate "malformed").
	malformed: boolean
	private readonly groupByName: Int8Array
	private readonly flat: boolean
	private readonly rPrefixes: readonly string[] | undefined

	constructor(document: XmlDocument) {
		this.document = document
		this.namespaces = new Namespaces(document, { lenient: true })
		this.malformed = this.namespaces.malformed.length > 0 || document.malformed.length > 0

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
		this.rPrefixes = flat ? this.prefixesOf(root, G.R) : undefined
	}

	private prefixesOf(node: number, group: G): string[] {
		const out: string[] = []

		for (const [prefix, uri] of this.namespaces.inScope(node)) {
			if (prefix !== "" && groupOf(uri) === group) out.push(prefix)
		}

		return out
	}

	group(node: number): G {
		const document = this.document

		if (node < 0 || document.kinds[node] !== NodeKind.Element) return G.None

		const id = document.nameIds[node] ?? 0

		if (this.flat) {
			const cached = this.groupByName[id] ?? UNSET

			if (cached !== UNSET) return cached as G
		}

		const group = groupOf(this.namespaces.elementUri(node))

		if (this.flat) this.groupByName[id] = group

		return group
	}

	local(node: number): string {
		return this.document.localName(node)
	}

	is(node: number, group: G, local: string): boolean {
		return node >= 0 && this.group(node) === group && this.document.localName(node) === local
	}

	first(node: number): number {
		return node < 0 ? -1 : this.document.firstChildElement(node)
	}

	next(node: number): number {
		return this.document.nextSiblingElement(node)
	}

	child(node: number, group: G, local: string): number {
		for (let child = this.first(node); child >= 0; child = this.next(child)) {
			if (this.is(child, group, local)) return child
		}

		return -1
	}

	children(node: number, group: G, local: string): number[] {
		const out: number[] = []

		for (let child = this.first(node); child >= 0; child = this.next(child)) {
			if (this.is(child, group, local)) out.push(child)
		}

		return out
	}

	// A chain of children: path("cSld", "spTree") under P.
	path(node: number, group: G, ...locals: readonly string[]): number {
		let at = node

		for (const local of locals) at = this.child(at, group, local)

		return at
	}

	// The branch of an mc:AlternateContent we read (the Choice we understand, else the Fallback), or -1.
	alternate(node: number): number {
		try {
			return selectAlternateContent(this.namespaces, node, understood)
		} catch {
			this.malformed = true

			return -1
		}
	}

	attr(node: number, local: string): string | undefined {
		if (node < 0) return undefined

		try {
			return this.document.attribute(node, local)
		} catch {
			this.malformed = true

			return undefined
		}
	}

	// A relationship attribute (r:id, r:embed, r:link…) under any prefix bound to the relationships namespace.
	rel(node: number, local: string): string | undefined {
		if (node < 0) return undefined

		for (const prefix of this.rPrefixes ?? this.prefixesOf(node, G.R)) {
			const value = this.attr(node, `${prefix}:${local}`)

			if (value !== undefined) return value
		}

		return undefined
	}

	// An attribute in another namespace group (p14:…, a16:…), under any prefix bound to it at `node`.
	attrNs(node: number, group: G, local: string): string | undefined {
		if (node < 0) return undefined

		for (const prefix of this.prefixesOf(node, group)) {
			const value = this.attr(node, `${prefix}:${local}`)

			if (value !== undefined) return value
		}

		return undefined
	}

	int(node: number, local: string): number | undefined {
		const text = this.attr(node, local)

		if (text === undefined) return undefined

		const value = Number(text.trim())

		return text.trim() !== "" && Number.isFinite(value) ? Math.trunc(value) : undefined
	}

	number(node: number, local: string): number | undefined {
		const text = this.attr(node, local)

		if (text === undefined) return undefined

		const value = Number(text.trim())

		return text.trim() !== "" && Number.isFinite(value) ? value : undefined
	}

	bool(node: number, local: string): boolean | undefined {
		const text = this.attr(node, local)

		if (text === undefined) return undefined

		const value = text.trim().toLowerCase()

		return value === "1" || value === "true" || value === "on"
	}

	// ST_Coordinate (EMU, or a universal measure in Strict).
	emu(node: number, local: string): number | undefined {
		const text = this.attr(node, local)

		if (text === undefined) return undefined

		const value = parseEmu(text, Number.NaN)

		return Number.isNaN(value) ? undefined : Math.round(value)
	}

	// ST_Percentage and friends in 1/100,000 ("50000", or "50%" in Strict).
	percent(node: number, local: string): number | undefined {
		const text = this.attr(node, local)

		if (text === undefined) return undefined

		const value = parseFraction(text, Number.NaN)

		return Number.isNaN(value) ? undefined : Math.round(value * 100000)
	}

	text(node: number): string {
		if (node < 0) return ""

		try {
			return this.document.textContent(node)
		} catch {
			this.malformed = true

			return ""
		}
	}
}

const shared = new WeakMap<XmlDocument, PartReader>()

export function partReader(document: XmlDocument): PartReader {
	let reader = shared.get(document)

	if (reader === undefined) {
		reader = new PartReader(document)
		shared.set(document, reader)
	}

	return reader
}
