import striptags from "striptags"
import { checklistParser } from "./checklistParser"
import { decodeHtmlEntities } from "./htmlEntities"

// Rich notes are Quill HTML, whose text escapes `&`, `<` and `>`. Decoding after the tags are gone keeps
// an escaped "<Header>" as text instead of stripping it.
function richPreview(html: string): string {
	return decodeHtmlEntities(striptags(html)).slice(0, 128)
}

export function createNotePreviewFromContentText(type: "rich" | "checklist" | "other", content?: string): string {
	try {
		if (!content || content.length === 0) {
			return ""
		}

		if (type === "rich") {
			if (content.indexOf("<p><br></p>") === -1) {
				return richPreview(content.split("\n")[0] ?? "")
			}

			return richPreview(content.split("<p><br></p>")[0] ?? "")
		}

		if (type === "checklist") {
			return checklistParser.firstNonEmptyContent(content).slice(0, 128)
		}

		return striptags(content.split("\n")[0] ?? "").slice(0, 128)
	} catch {
		return ""
	}
}
