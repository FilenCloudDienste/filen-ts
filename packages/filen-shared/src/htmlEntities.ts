import { TextNode } from "node-html-better-parser"

const STRICT_REFERENCE = /&(?:#\d+|#[xX][\da-fA-F]+|[0-9a-zA-Z]+);/g

// Decodes only references that end in ";" (html-entities' strict scope), which is everything
// checklistParser's stringify, browsers and Quill write. Each goes through node-html-better-parser's own
// html-entities copy: a direct import resolves html-entities' ESM build beside the CommonJS one the parser
// requires (Metro picks the build per import or require), building its entity tables twice at startup.
export function decodeHtmlEntities(text: string): string {
	if (!text.includes("&")) {
		return text
	}

	return text.replace(STRICT_REFERENCE, reference => {
		const decoded = new TextNode(reference).text

		// `.text` also reads a legacy name that lacks its ";", so an unknown name with a legacy prefix comes
		// back partly decoded ("&copyright;" as "©right;"). Strict scope keeps it literal. Only "&semi;"
		// decodes to something ending in ";", and that is one character.
		return decoded.length > 1 && decoded.endsWith(";") ? reference : decoded
	})
}
