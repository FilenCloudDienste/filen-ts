import type { OdfPackage } from "../../odf/package"
import type { OpcPackage } from "../../opc/index"
import { escapeAttribute, escapeText, XmlError, type XmlDocument } from "../../xml/index"
import type { ConversionReport } from "./report"

// A document's properties on their way to the other format: PresentationML's core properties (docProps/core.xml,
// ECMA-376 Part 2 §11) and custom properties (docProps/custom.xml, Part 1 §22.3) and ODF's meta.xml (ODF 1.3 Part 3
// §4.3: dc:title, dc:subject, dc:description, meta:keyword, meta:initial-creator, dc:creator, meta:creation-date,
// dc:date, meta:print-date, dc:language, meta:editing-cycles, meta:user-defined). What one side has no place for
// (core.xml's category, content status, identifier and version; a custom property of a binary or vector type) is
// counted; nothing is dropped silently.

interface Property {
	readonly name: string
	readonly value: string
	// ODF value types (§19.389): float, date, time, boolean, string (absent).
	readonly type?: "float" | "date" | "boolean"
}

export interface DocumentProperties {
	readonly title?: string
	readonly subject?: string
	readonly description?: string
	readonly keywords?: string
	readonly creator?: string
	readonly lastModifiedBy?: string
	readonly created?: string
	readonly modified?: string
	readonly printed?: string
	readonly language?: string
	readonly revision?: string
	readonly custom: readonly Property[]
}

const CORE_PROPERTIES = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
const CUSTOM_PROPERTIES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"

// An attribute by its local name, whatever its prefix.
function attributeNamed(document: XmlDocument, node: number, local: string): string | undefined {
	for (const attribute of document.attributes(node)) {
		const colon = attribute.name.indexOf(":")

		if ((colon < 0 ? attribute.name : attribute.name.slice(colon + 1)) === local && !attribute.name.startsWith("xmlns"))
			return attribute.value
	}

	return undefined
}

function childText(document: XmlDocument, parent: number, local: string): string | undefined {
	for (let child = document.firstChildElement(parent); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === local) return document.textContent(child)

	return undefined
}

async function packageXml(opc: OpcPackage, type: string): Promise<XmlDocument | undefined> {
	const name = (await opc.relationships("")).all.find(relationship => relationship.type === type && !relationship.external)?.partName

	if (name === undefined || !opc.has(name)) return undefined

	try {
		return await opc.xml(name)
	} catch (error) {
		// A damaged properties part carries nothing (the deck itself read without it).
		if (error instanceof XmlError) return undefined

		throw error
	}
}

const CORE_ONLY = ["category", "contentStatus", "identifier", "version"]

// The core and custom properties of a PresentationML package.
export async function pptxProperties(opc: OpcPackage, report: ConversionReport): Promise<DocumentProperties | undefined> {
	const core = await packageXml(opc, CORE_PROPERTIES)
	const customs = await packageXml(opc, CUSTOM_PROPERTIES)

	if (core === undefined && customs === undefined) return undefined

	const root = core?.documentElement() ?? -1
	const get = (local: string): string | undefined => (core === undefined ? undefined : childText(core, root, local))
	const custom: Property[] = []

	if (core !== undefined) for (const local of CORE_ONLY) if ((get(local) ?? "") !== "") report.note("properties")

	if (customs !== undefined) {
		for (
			let property = customs.firstChildElement(customs.documentElement());
			property >= 0;
			property = customs.nextSiblingElement(property)
		) {
			const name = attributeNamed(customs, property, "name")
			const value = customs.firstChildElement(property)

			if (name === undefined || value < 0) continue

			const type = customs.localName(value)
			const text = customs.textContent(value)

			if (type === "lpwstr" || type === "lpstr" || type === "bstr") custom.push({ name, value: text })
			else if (/^(?:i[1248]|ui[1248]|int|uint|r[48]|decimal)$/u.test(type)) custom.push({ name, value: text, type: "float" })
			else if (type === "bool") custom.push({ name, value: text === "1" || text === "true" ? "true" : "false", type: "boolean" })
			else if (type === "filetime" || type === "date") custom.push({ name, value: text, type: "date" })
			else report.note("properties")
		}
	}

	const optional = (key: keyof Omit<DocumentProperties, "custom">, value: string | undefined) =>
		value === undefined || value.trim() === "" ? {} : { [key]: value.trim() }

	return {
		...optional("title", get("title")),
		...optional("subject", get("subject")),
		...optional("description", get("description")),
		...optional("keywords", get("keywords")),
		...optional("creator", get("creator")),
		...optional("lastModifiedBy", get("lastModifiedBy")),
		...optional("created", get("created")),
		...optional("modified", get("modified")),
		...optional("printed", get("lastPrinted")),
		...optional("language", get("language")),
		...optional("revision", get("revision")),
		custom
	}
}

// The properties of an ODF package's meta.xml.
export async function odfProperties(odf: OdfPackage): Promise<DocumentProperties | undefined> {
	let meta: XmlDocument | undefined

	try {
		meta = await odf.xml("meta.xml")
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}

	if (meta === undefined) return undefined

	let block = -1

	for (let child = meta.firstChildElement(meta.documentElement()); child >= 0; child = meta.nextSiblingElement(child))
		if (meta.localName(child) === "meta") block = child

	if (block < 0) return undefined

	const get = (local: string): string | undefined => {
		const value = childText(meta, block, local)?.trim()

		return value === undefined || value === "" ? undefined : value
	}
	const keywords: string[] = []
	const custom: Property[] = []

	for (let child = meta.firstChildElement(block); child >= 0; child = meta.nextSiblingElement(child)) {
		const local = meta.localName(child)

		if (local === "keyword") keywords.push(meta.textContent(child).trim())
		else if (local === "user-defined") {
			const name = attributeNamed(meta, child, "name") ?? ""
			const type = attributeNamed(meta, child, "value-type")
			const value = meta.textContent(child)

			if (name === "") continue

			custom.push({
				name,
				value,
				...(type === "float" || type === "date" || type === "boolean" ? { type } : {})
			})
		}
	}

	const optional = (key: keyof Omit<DocumentProperties, "custom">, value: string | undefined) =>
		value === undefined ? {} : { [key]: value }

	return {
		...optional("title", get("title")),
		...optional("subject", get("subject")),
		...optional("description", get("description")),
		...optional("keywords", keywords.length === 0 ? undefined : keywords.join(", ")),
		...optional("creator", get("initial-creator")),
		...optional("lastModifiedBy", get("creator")),
		...optional("created", get("creation-date")),
		...optional("modified", get("date")),
		...optional("printed", get("print-date")),
		...optional("language", get("language")),
		...optional("revision", get("editing-cycles")),
		custom
	}
}

function element(tag: string, value: string | undefined): string {
	return value === undefined ? "" : `<${tag}>${escapeText(value)}</${tag}>`
}

// meta.xml (ODF 1.3 Part 3 §4.3).
export function metaXml(properties: DocumentProperties): string {
	const custom = properties.custom
		.map(
			property =>
				`<meta:user-defined meta:name="${escapeAttribute(property.name)}"${property.type === undefined ? "" : ` meta:value-type="${property.type}"`}>${escapeText(property.value)}</meta:user-defined>`
		)
		.join("")

	return (
		'<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta>' +
		element("dc:title", properties.title) +
		element("dc:subject", properties.subject) +
		element("dc:description", properties.description) +
		element("meta:keyword", properties.keywords) +
		element("meta:initial-creator", properties.creator) +
		element("dc:creator", properties.lastModifiedBy) +
		element("meta:creation-date", properties.created) +
		element("dc:date", properties.modified) +
		element("meta:print-date", properties.printed) +
		element("dc:language", properties.language) +
		element("meta:editing-cycles", properties.revision) +
		`${custom}</office:meta></office:document-meta>`
	)
}

// docProps/core.xml (ECMA-376 Part 2 §11).
export function coreXml(properties: DocumentProperties): string {
	const date = (tag: string, value: string | undefined) =>
		value === undefined ? "" : `<${tag} xsi:type="dcterms:W3CDTF">${escapeText(value)}</${tag}>`

	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
		element("dc:title", properties.title) +
		element("dc:subject", properties.subject) +
		element("dc:creator", properties.creator) +
		element("cp:keywords", properties.keywords) +
		element("dc:description", properties.description) +
		element("cp:lastModifiedBy", properties.lastModifiedBy) +
		element("cp:revision", properties.revision) +
		date("dcterms:created", properties.created) +
		date("dcterms:modified", properties.modified) +
		element("cp:lastPrinted", properties.printed) +
		element("dc:language", properties.language) +
		"</cp:coreProperties>"
	)
}

// docProps/custom.xml (ECMA-376 Part 1 §22.3), or undefined without custom properties.
export function customXml(properties: DocumentProperties): string | undefined {
	if (properties.custom.length === 0) return undefined

	const list = properties.custom
		.map((property, index) => {
			const vt =
				property.type === "float" ? "r8" : property.type === "boolean" ? "bool" : property.type === "date" ? "filetime" : "lpwstr"

			return `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${String(index + 2)}" name="${escapeAttribute(property.name)}"><vt:${vt}>${escapeText(property.value)}</vt:${vt}></property>`
		})
		.join("")

	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${list}</Properties>`
}
