import type { XmlDocument } from "../../xml/index"

// WordprocessingML reading the writer (emit.ts) and the proof (digest.ts) must agree on: one copy for both.

// A toggle's w:val that turns it off.
export const OFF = new Set(["0", "false", "off"])
// Elements holding a run's text.
export const TEXT = new Set(["t", "delText", "instrText", "delInstrText"])

// Whether a text element keeps its edge whitespace (xml:space="preserve" on it or the nearest ancestor setting it).
export function preserves(document: XmlDocument, node: number): boolean {
	for (let at = node; at > 0; at = document.parent(at)) {
		const space = document.attribute(at, "xml:space")

		if (space !== undefined) return space === "preserve"
	}

	return false
}

// The first element named `local` below `node`, depth first.
export function descendant(document: XmlDocument, node: number, local: string): number {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child

		const found = descendant(document, child, local)

		if (found >= 0) return found
	}

	return -1
}
