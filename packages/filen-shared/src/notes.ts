import striptags from "striptags"
import { checklistParser } from "./checklistParser"
import { decodeHtmlEntities } from "./htmlEntities"

const PREVIEW_LENGTH = 128
const STRIP_CHUNK = 4096
// Characters a strict reference can hold between its "&" and its closing ";".
const REFERENCE_BODY_END = /[^#0-9A-Za-z]/g

function beforeFirst(content: string, separator: string): string {
	const index = content.indexOf(separator)

	return index === -1 ? content : content.slice(0, index)
}

// striptags' stream keeps its tag state across chunks, so the chunk outputs concatenate to striptags(text)
// and only grow at the end: once `enough` holds, later chunks only append past the preview.
function stripUntil(text: string, enough: (stripped: string) => boolean): string {
	if (text.length <= STRIP_CHUNK) {
		return striptags(text)
	}

	const strip = striptags.init_streaming_mode()
	let stripped = ""

	for (let start = 0; start < text.length; start += STRIP_CHUNK) {
		stripped += strip(text.slice(start, start + STRIP_CHUNK))

		if (enough(stripped)) {
			break
		}
	}

	return stripped
}

// A reference match starts at "&" and holds no other "&", so only one starting at the last "&" can straddle
// the cut, and only while everything after that "&" could still be its body.
function decodedPreviewSettled(stripped: string): boolean {
	const amp = stripped.lastIndexOf("&")

	if (amp === -1) {
		return stripped.length >= PREVIEW_LENGTH
	}

	REFERENCE_BODY_END.lastIndex = amp + 1

	const settledEnd = REFERENCE_BODY_END.test(stripped) ? stripped.length : amp

	return decodeHtmlEntities(stripped.slice(0, settledEnd)).length >= PREVIEW_LENGTH
}

// Rich notes are Quill HTML, whose text escapes `&`, `<` and `>`. Decoding after the tags are gone keeps
// an escaped "<Header>" as text instead of stripping it.
function richPreview(html: string): string {
	return decodeHtmlEntities(stripUntil(html, decodedPreviewSettled)).slice(0, PREVIEW_LENGTH)
}

export function createNotePreviewFromContentText(type: "rich" | "checklist" | "other", content?: string): string {
	try {
		if (!content || content.length === 0) {
			return ""
		}

		if (type === "rich") {
			const blank = content.indexOf("<p><br></p>")

			return richPreview(blank === -1 ? beforeFirst(content, "\n") : content.slice(0, blank))
		}

		if (type === "checklist") {
			return checklistParser.firstNonEmptyContent(content).slice(0, PREVIEW_LENGTH)
		}

		return stripUntil(beforeFirst(content, "\n"), stripped => stripped.length >= PREVIEW_LENGTH).slice(0, PREVIEW_LENGTH)
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
