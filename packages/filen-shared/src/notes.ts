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

// Note history newest first. `id` breaks a timestamp tie: history ids are server-assigned and increasing,
// so the higher id is the later edit. Bigint throughout; does not mutate the input.
export function sortNoteHistory<T extends { id: bigint; editedTimestamp: bigint }>(history: readonly T[]): T[] {
	return [...history].sort((a, b) => {
		if (a.editedTimestamp !== b.editedTimestamp) {
			return a.editedTimestamp > b.editedTimestamp ? -1 : 1
		}

		return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
	})
}
