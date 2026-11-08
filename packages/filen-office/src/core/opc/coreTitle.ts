import { corePropertiesPart } from "./coreProperties"
import type { OpcPackage } from "./package"

// What a package's core properties say of the document (ECMA-376 Part 2 §11.1), each with whitespace collapsed; blank
// or none: undefined. `author` is dc:creator, `keywords` cp:keywords as written.
export interface CoreProperties {
	readonly title: string | undefined
	readonly author: string | undefined
	readonly subject: string | undefined
	readonly keywords: string | undefined
}

const NO_PROPERTIES: CoreProperties = { title: undefined, author: undefined, subject: undefined, keywords: undefined }

// The title a package's core properties give (dc:title). A missing or malformed core part names none.
export async function coreTitle(opc: OpcPackage): Promise<string | undefined> {
	return (await coreProperties(opc)).title
}

// The core part read once. A missing or malformed core part names nothing.
export async function coreProperties(opc: OpcPackage): Promise<CoreProperties> {
	try {
		const core = await corePropertiesPart(opc)

		if (core === undefined) return NO_PROPERTIES

		const xml = await opc.xml(core)
		const root = xml.documentElement()
		let title: string | undefined
		let author: string | undefined
		let subject: string | undefined
		let keywords: string | undefined

		// The first of each; textContent decodes character references, so an invalid one names nothing at all.
		for (let child = xml.firstChildElement(root); child >= 0; child = xml.nextSiblingElement(child)) {
			const name = xml.localName(child)

			if (name === "title") title ??= collapsed(xml.textContent(child))
			else if (name === "creator") author ??= collapsed(xml.textContent(child))
			else if (name === "subject") subject ??= collapsed(xml.textContent(child))
			else if (name === "keywords") keywords ??= collapsed(xml.textContent(child))
		}

		return { title, author, subject, keywords }
	} catch {
		// A missing or malformed core part names nothing.
	}

	return NO_PROPERTIES
}

function collapsed(text: string): string | undefined {
	const value = text.replace(/\s+/g, " ").trim()

	return value.length > 0 ? value : undefined
}
