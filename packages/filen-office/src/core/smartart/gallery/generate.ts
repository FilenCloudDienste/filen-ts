import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { encodeUtf8, parseXml, type XmlDocument } from "../../xml/index"
import type { SmartArtCategory } from "./index"

// The gallery's data, generated from our own definition files (assets/smartart/<family>-*.xml): a names module (the
// page-safe registry entries: uniqueId, category, the locale key of the name, the sample data the preview and the
// insert use) and a definitions module (the worker's uniqueId → definition text, comments and indentation removed).
// Every file starts with the authorship header: a comment saying it is a Filen gallery definition written from
// ECMA-376 §21.4, and naming its locale key ("nameKey: …"). The family's modules are <family>.ts and
// <family>Defs.ts beside this file; tests/smartartGallery.test.ts checks they match the assets and writes them when
// FILEN_SMARTART_GALLERY_WRITE=1.

export interface GallerySource {
	// The asset's file name ("list-basic.xml"), for messages and the order of definitions of equal priority.
	readonly file: string
	readonly xml: string
}

export interface GeneratedGallery {
	// The names module's source and the definitions module's (before formatting).
	readonly names: string
	readonly defs: string
}

const CATEGORIES: ReadonlySet<SmartArtCategory> = new Set([
	"list",
	"process",
	"cycle",
	"hierarchy",
	"relationship",
	"matrix",
	"pyramid",
	"picture"
])
const AUTHORSHIP = /^\s*(?:<\?xml[^>]*\?>\s*)?<!--([\s\S]*?)-->/u
const HEADER = /Filen SmartArt gallery definition/u
const NAME_KEY = /nameKey:\s*([A-Za-z][A-Za-z0-9]*)/u
const MAX_SAMPLE = 64
// ST_ModelId (§21.4.7.43): an xsd:int or an ST_Guid ("{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}").
const MODEL_ID = /^(?:[+-]?\d{1,10}|\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\})$/u
const INT_MIN = -2147483648
const INT_MAX = 2147483647

type Kind = "layout" | "style" | "colors"

interface Read {
	readonly kind: Kind
	readonly uniqueId: string
	readonly nameKey: string
	readonly category: string | undefined
	readonly priority: number
	readonly file: string
	readonly sample: readonly { readonly level: number; readonly text: string }[]
	readonly text: string
}

const ROOTS: Readonly<Record<string, Kind>> = { layoutDef: "layout", styleDef: "style", colorsDef: "colors" }

function validModelId(value: string): boolean {
	if (!MODEL_ID.test(value)) return false
	if (value.startsWith("{")) return true

	const number = Number(value)

	return number >= INT_MIN && number <= INT_MAX
}

// Every model id a definition's sample, style or colour data model names (pt modelId, cxn modelId/srcId/destId/
// parTransId/sibTransId/presId) is a valid ST_ModelId: an inserted diagram's layout part carries them as written.
function checkModelIds(document: XmlDocument, reader: DrawingReader, root: number, file: string): void {
	const visit = (node: number): void => {
		for (const attribute of ["modelId", "srcId", "destId", "parTransId", "sibTransId", "cxnId"]) {
			const value = reader.attr(node, attribute)

			if (value !== undefined && !validModelId(value)) throw new Error(`${file}: ${attribute}="${value}" is not an ST_ModelId`)
		}

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) visit(child)
	}

	visit(root)
}

// The sample data model's nodes depth first, each with its level under the doc point and its text.
function sampleOf(reader: DrawingReader, sampData: number): { level: number; text: string }[] {
	const model = reader.child(sampData, D.Dgm, "dataModel")
	const texts = new Map<string, string>()
	let root: string | undefined

	for (const pt of reader.children(reader.child(model, D.Dgm, "ptLst"), D.Dgm, "pt")) {
		const id = reader.attr(pt, "modelId")
		const type = reader.attr(pt, "type") ?? "node"

		if (id === undefined) continue
		if (type === "doc") root ??= id
		if (type !== "node") continue

		const paragraphs = reader.children(reader.child(pt, D.Dgm, "t"), D.A, "p").map(p =>
			reader
				.children(p, D.A, "r")
				.map(r => reader.text(reader.child(r, D.A, "t")))
				.join("")
		)

		texts.set(id, paragraphs.join("\n"))
	}

	const children = new Map<string, { id: string; ord: number }[]>()

	for (const cxn of reader.children(reader.child(model, D.Dgm, "cxnLst"), D.Dgm, "cxn")) {
		if ((reader.attr(cxn, "type") ?? "parOf") !== "parOf") continue

		const src = reader.attr(cxn, "srcId")
		const dest = reader.attr(cxn, "destId")

		if (src === undefined || dest === undefined || !texts.has(dest)) continue

		const list = children.get(src) ?? []

		list.push({ id: dest, ord: reader.number(cxn, "srcOrd", 0) })
		children.set(src, list)
	}

	const out: { level: number; text: string }[] = []
	const visited = new Set<string>()
	const walk = (id: string, level: number): void => {
		for (const child of (children.get(id) ?? []).sort((a, b) => a.ord - b.ord)) {
			if (visited.has(child.id) || out.length >= MAX_SAMPLE) continue

			visited.add(child.id)
			out.push({ level, text: texts.get(child.id) ?? "" })
			walk(child.id, level + 1)
		}
	}

	if (root !== undefined) walk(root, 1)

	return out
}

// Comments and the indentation between elements removed, one element per line as written (whitespace inside an
// element's text is kept).
export function minifyDefinition(xml: string): string {
	return xml
		.replace(/<\?xml[^>]*\?>/gu, "")
		.replace(/<!--[\s\S]*?-->/gu, "")
		.replace(/>\s*\n\s*</gu, ">\n<")
		.trim()
}

function read(source: GallerySource): Read {
	const header = AUTHORSHIP.exec(source.xml)?.[1]

	if (header === undefined || !HEADER.test(header)) throw new Error(`${source.file}: no authorship header`)

	const nameKey = NAME_KEY.exec(header)?.[1]

	if (nameKey === undefined) throw new Error(`${source.file}: the header names no nameKey`)

	const document = parseXml(encodeUtf8(source.xml))
	const reader = drawingReader(document)
	const root = document.documentElement()
	const kind = reader.group(root) === D.Dgm ? ROOTS[document.localName(root)] : undefined

	if (kind === undefined) throw new Error(`${source.file}: not a layout, style or colours definition`)

	checkModelIds(document, reader, root, source.file)

	const uniqueId = reader.attr(root, "uniqueId") ?? ""

	if (uniqueId === "") throw new Error(`${source.file}: no uniqueId`)

	const cat = reader.child(reader.child(root, D.Dgm, "catLst"), D.Dgm, "cat")
	const category = reader.attr(cat, "type")

	if (kind === "layout" && (category === undefined || !CATEGORIES.has(category as SmartArtCategory)))
		throw new Error(`${source.file}: the category ${String(category)} is not one of the gallery's`)

	return {
		kind,
		uniqueId,
		nameKey,
		category,
		priority: reader.number(cat, "pri", Number.MAX_SAFE_INTEGER),
		file: source.file,
		sample: kind === "layout" ? sampleOf(reader, reader.child(root, D.Dgm, "sampData")) : [],
		text: minifyDefinition(source.xml)
	}
}

function constantOf(family: string): string {
	return family.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()
}

// The two modules of one family, from its definition files.
export function generateGallery(family: string, sources: readonly GallerySource[]): GeneratedGallery {
	const reads = sources.map(read).sort((a, b) => a.priority - b.priority || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
	const seen = new Set<string>()

	for (const each of reads) {
		const key = `${each.kind}\u0000${each.uniqueId}`

		if (seen.has(key)) throw new Error(`${each.file}: uniqueId ${each.uniqueId} is used twice`)

		seen.add(key)
	}

	const name = constantOf(family)
	const of = (kind: Kind): Read[] => reads.filter(each => each.kind === kind)
	const files = [...new Set(reads.map(each => each.file))].sort().join(", ")
	const header = `// Generated by core/smartart/gallery/generate.ts from assets/smartart (${files}): edit the assets, not this file.\n`
	const layouts = of("layout").map(
		each =>
			`{ uniqueId: ${JSON.stringify(each.uniqueId)}, category: ${JSON.stringify(each.category)}, nameKey: ${JSON.stringify(each.nameKey)}, sample: ${JSON.stringify(each.sample)} }`
	)
	const entries = (kind: Kind): string[] =>
		of(kind).map(each => `{ uniqueId: ${JSON.stringify(each.uniqueId)}, nameKey: ${JSON.stringify(each.nameKey)} }`)
	const definitions = (kind: Kind): string[] => of(kind).map(each => `[${JSON.stringify(each.uniqueId)}, ${JSON.stringify(each.text)}]`)
	const names =
		header +
		'import type { SmartArtColorsEntry, SmartArtLayoutEntry, SmartArtStyleEntry } from "./index"\n\n' +
		`export const ${name}_LAYOUTS: readonly SmartArtLayoutEntry[] = [${layouts.join(", ")}]\n\n` +
		`export const ${name}_STYLES: readonly SmartArtStyleEntry[] = [${entries("style").join(", ")}]\n\n` +
		`export const ${name}_COLORS: readonly SmartArtColorsEntry[] = [${entries("colors").join(", ")}]\n`
	const defs =
		header +
		`export const ${name}_LAYOUT_DEFS: readonly (readonly [string, string])[] = [${definitions("layout").join(", ")}]\n\n` +
		`export const ${name}_STYLE_DEFS: readonly (readonly [string, string])[] = [${definitions("style").join(", ")}]\n\n` +
		`export const ${name}_COLORS_DEFS: readonly (readonly [string, string])[] = [${definitions("colors").join(", ")}]\n`

	return { names, defs }
}
