import { ZipError, type SliceClock } from "../opc/index"
import { Namespaces, XmlEditor, XmlError, assertWellFormed, parseXml, type XmlDocument } from "../xml/index"
import { OdfNs } from "./namespaces"
import type { OdfPackage } from "./package"

// office:meta of a meta.xml (office:document-meta > office:meta), and its namespaces; undefined: none.
function officeMeta(document: XmlDocument): { readonly meta: number; readonly ns: Namespaces } | undefined {
	const ns = new Namespaces(document)
	const root = document.documentElement()

	if (root < 0 || !ns.is(root, OdfNs.office, "document-meta")) return undefined

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (ns.is(child, OdfNs.office, "meta")) return { meta: child, ns }
	}

	return undefined
}

// meta.xml as a save leaves it (ODF 1.3 Part 3 §4.3.2): dc:date `date` (§4.3.2.8), meta:editing-cycles one more
// (§4.3.2.12; 1 when unreadable or absent), meta:document-statistic dropped, since no count it holds is known to
// hold after an edit. The generator (which readers key compatibility handling on), the people named and the editing
// time stay. Everything else is copied byte for byte. Undefined: the part is to be copied as it is (malformed, or no
// office:meta).
export function metaOnSave(bytes: Uint8Array, date: string): Uint8Array | undefined {
	try {
		const document = parseXml(bytes)

		assertWellFormed(document)

		const found = officeMeta(document)

		if (found === undefined) return undefined

		const { meta, ns } = found
		const editor = new XmlEditor(document)
		let dated = false
		let counted = false

		for (let child = document.firstChildElement(meta); child >= 0; child = document.nextSiblingElement(child)) {
			if (!dated && ns.is(child, OdfNs.dc, "date")) {
				editor.setText(child, date)
				dated = true
			} else if (!counted && ns.is(child, OdfNs.meta, "editing-cycles")) {
				const was = document.textContent(child).trim()
				const cycles = /^\d+$/u.test(was) ? Number(was) : 0

				editor.setText(child, String(Number.isSafeInteger(cycles + 1) ? cycles + 1 : 1))
				counted = true
			} else if (ns.is(child, OdfNs.meta, "document-statistic")) editor.remove(child)
		}

		const element = (uri: string, fallback: string, local: string, text: string): string => {
			const prefix = ns.prefixFor(meta, uri)

			return prefix === undefined
				? `<${fallback}:${local} xmlns:${fallback}="${uri}">${text}</${fallback}:${local}>`
				: `<${prefix === "" ? "" : `${prefix}:`}${local}>${text}</${prefix === "" ? "" : `${prefix}:`}${local}>`
		}

		if (!dated) editor.append(meta, element(OdfNs.dc, "dc", "date", date))
		if (!counted) editor.append(meta, element(OdfNs.meta, "meta", "editing-cycles", "1"))

		const out = editor.serialize()

		assertWellFormed(parseXml(out))

		return out
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}
}

// The dc:date in office:meta of a meta.xml; undefined: none, or the part does not read.
export function metaDate(bytes: Uint8Array): string | undefined {
	try {
		const document = parseXml(bytes)
		const found = officeMeta(document)

		if (found === undefined) return undefined

		for (let child = document.firstChildElement(found.meta); child >= 0; child = document.nextSiblingElement(child)) {
			if (found.ns.is(child, OdfNs.dc, "date")) return document.textContent(child)
		}
	} catch (error) {
		if (!(error instanceof XmlError)) throw error
	}

	return undefined
}

// The document's own title (meta.xml: office:document-meta > office:meta > dc:title, ODF 1.3 Part 3 §4.3.2.2),
// whitespace collapsed; blank or none: undefined. A damaged meta.xml names none.
export async function metaTitle(odf: OdfPackage, clock?: SliceClock): Promise<string | undefined> {
	try {
		const meta = await odf.xml("meta.xml", clock)

		if (meta === undefined) return undefined

		for (let block = meta.firstChildElement(meta.documentElement()); block >= 0; block = meta.nextSiblingElement(block)) {
			if (meta.localName(block) !== "meta") continue

			for (let child = meta.firstChildElement(block); child >= 0; child = meta.nextSiblingElement(child)) {
				if (meta.localName(child) !== "title") continue

				// textContent decodes character references, so an invalid one (&#x1;) raises here.
				const title = meta.textContent(child).replace(/\s+/g, " ").trim()

				return title.length > 0 ? title : undefined
			}
		}
	} catch (error) {
		if (!(error instanceof XmlError || error instanceof ZipError)) throw error
	}

	return undefined
}
