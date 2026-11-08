import { Namespaces, escapeText, type XmlEditor } from "../xml/index"
import type { OpcPackage } from "./package"

const CORE_PROPERTIES = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
const STRICT_CORE_PROPERTIES = "http://purl.oclc.org/ooxml/officeDocument/relationships/metadata/core-properties"
const DCTERMS = "http://purl.org/dc/terms/"
const XSI = "http://www.w3.org/2001/XMLSchema-instance"

// The core properties part (ECMA-376 Part 2 §11) the package relationships name, when the package has it.
export async function corePropertiesPart(opc: OpcPackage): Promise<string | undefined> {
	const relationships = await opc.relationships("")
	const core = relationships.all.find(
		relationship =>
			!relationship.external &&
			(relationship.type === CORE_PROPERTIES || relationship.type === STRICT_CORE_PROPERTIES) &&
			relationship.partName !== undefined
	)

	return core?.partName !== undefined && opc.has(core.partName) ? core.partName : undefined
}

export interface CoreStamp {
	// ms since the epoch.
	readonly modified: number
	// Left as the part has it when undefined.
	readonly lastModifiedBy: string | undefined
}

// A save's core properties, as Word writes them on save: dcterms:modified, cp:lastModifiedBy and cp:revision
// (one more, when it is a count). A missing modified or lastModifiedBy is appended, with the namespaces it
// needs declared on the root; nothing else of the part changes. A root that is not cp:coreProperties is left.
export function stampCoreProperties(editor: XmlEditor, stamp: CoreStamp): void {
	const document = editor.document
	const root = document.documentElement()
	const namespaces = new Namespaces(document, { lenient: true })
	const cp = namespaces.elementUri(root)

	if (cp === undefined || document.localName(root) !== "coreProperties") return

	let modified = -1
	let lastModifiedBy = -1
	let revision = -1

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (modified < 0 && namespaces.is(child, DCTERMS, "modified")) modified = child
		else if (lastModifiedBy < 0 && namespaces.is(child, cp, "lastModifiedBy")) lastModifiedBy = child
		else if (revision < 0 && namespaces.is(child, cp, "revision")) revision = child
	}

	const declared = new Map<string, string>()
	// The prefix `uri` has at `node`, declared on the root under a free name when not in scope (an attribute's
	// cannot be the default namespace).
	const prefix = (node: number, uri: string, preferred: string, attribute: boolean): string => {
		const found = namespaces.prefixFor(node, uri)

		if (found !== undefined && (found !== "" || !attribute)) return found

		const made = declared.get(uri)

		if (made !== undefined) return made

		let name = preferred

		for (let n = 1; namespaces.uri(root, name) !== undefined || namespaces.uri(node, name) !== undefined; n++) name = `${preferred}${n}`

		editor.setAttribute(root, `xmlns:${name}`, uri)
		declared.set(uri, name)

		return name
	}
	const qualified = (name: string, local: string): string => (name === "" ? local : `${name}:${local}`)
	const date = new Date(stamp.modified).toISOString().replace(/\.\d+Z$/, "Z")
	let appended = ""

	if (modified >= 0) {
		const type = qualified(document.prefix(modified), "W3CDTF")
		let attribute: string | undefined

		for (const { name } of document.attributes(modified)) {
			const colon = name.indexOf(":")

			if (colon > 0 && name.slice(colon + 1) === "type" && namespaces.uri(modified, name.slice(0, colon)) === XSI) attribute = name
		}

		editor.setAttribute(modified, attribute ?? qualified(prefix(modified, XSI, "xsi", true), "type"), type)
		editor.setText(modified, date)
	} else {
		const element = qualified(prefix(root, DCTERMS, "dcterms", false), "modified")

		appended += `<${element} ${qualified(prefix(root, XSI, "xsi", true), "type")}="${qualified(prefix(root, DCTERMS, "dcterms", false), "W3CDTF")}">${date}</${element}>`
	}

	if (stamp.lastModifiedBy !== undefined) {
		if (lastModifiedBy >= 0) {
			editor.setText(lastModifiedBy, stamp.lastModifiedBy)
		} else {
			const element = qualified(prefix(root, cp, "cp", false), "lastModifiedBy")

			appended += `<${element}>${escapeText(stamp.lastModifiedBy)}</${element}>`
		}
	}

	if (revision >= 0) {
		const count = document.textContent(revision)

		// cp:revision is a string; Word counts saves in it.
		if (/^\d+$/.test(count)) editor.setText(revision, (BigInt(count) + 1n).toString())
	}

	if (appended.length > 0) editor.append(root, appended)
}
