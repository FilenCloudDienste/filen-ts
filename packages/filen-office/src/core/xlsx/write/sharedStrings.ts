import { encodeUtf8, escapeText } from "../../xml/index"
import type { XlsxSharedStrings } from "../model/types"
import { Pieces, attr, findAttribute, lastIndexOfText, preserved, qualify, rootTag, spliceTag } from "./markup"
import { fontChildren } from "./records"

// sharedStrings.xml with the entries edits appended before its end (or its extLst), count and uniqueCount
// updated in place. The part can be large: it is never parsed here, only its root tag and its end are found.

export const SHARED_STRINGS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"

// The markup of entries [from, to).
function sharedStringsMarkup(strings: XlsxSharedStrings, from: number, to: number, prefix: string): string {
	const si = qualify(prefix, "si")
	const t = qualify(prefix, "t")
	const r = qualify(prefix, "r")
	const rPr = qualify(prefix, "rPr")
	let markup = ""

	for (let index = from; index < to; index++) {
		const runs = strings.runs(index)

		if (runs === null) {
			const text = strings.text(index)

			markup += `<${si}><${t}${preserved(text)}>${escapeText(text)}</${t}></${si}>`

			continue
		}

		markup += `<${si}>`

		for (const run of runs) {
			const properties = run.font === null ? "" : fontChildren(run.font, prefix, true)

			markup += `<${r}>${properties === "" ? "" : `<${rPr}>${properties}</${rPr}>`}<${t}${preserved(run.text)}>${escapeText(run.text)}</${t}></${r}>`
		}

		markup += `</${si}>`
	}

	return markup
}

export interface WrittenSharedStrings {
	readonly pieces: Pieces
	// The root's start tag as written, and the entries appended.
	readonly root: Uint8Array
	readonly appended: Uint8Array
	readonly prefix: string
	// The entries the part holds: the source's, and the appended ones up to the last a written cell refers to.
	readonly length: number
}

// The references the count attribute holds: the source's count (none when the part or its count was absent) plus
// those the edits added.
export function referenceCount(strings: XlsxSharedStrings): number {
	return Math.max(0, Math.max(0, strings.sourceCount) + strings.referenceDelta)
}

// `main`: the SpreadsheetML namespace of a new part; `length`: the entries written (appended ones past it are no
// cell's).
export function writeSharedStrings(
	strings: XlsxSharedStrings,
	length: number,
	source: Uint8Array | null,
	main: string
): WrittenSharedStrings {
	const pieces = new Pieces()

	if (source === null) {
		const root = encodeUtf8(`<sst xmlns="${main}"${attr("count", referenceCount(strings))}${attr("uniqueCount", length)}>`)
		const appended = encodeUtf8(sharedStringsMarkup(strings, 0, length, ""))

		pieces.text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n')
		pieces.push(root)
		pieces.push(appended)
		pieces.text("</sst>")

		return { pieces, root, appended, prefix: "", length }
	}

	const { tag, prefix } = rootTag(source)
	const updates = new Map<string, string>()
	const has = (name: string): boolean => findAttribute(source, tag, name) >= 0

	// Counts absent from the source stay absent (both are optional).
	if (has("count")) updates.set("count", String(referenceCount(strings)))
	if (has("uniqueCount")) updates.set("uniqueCount", String(length))

	const root = spliceTag(source, tag, updates, true)
	const appended = encodeUtf8(sharedStringsMarkup(strings, strings.sourceLength, length, prefix))

	pieces.push(source.subarray(0, tag.start))
	pieces.push(root)

	if (tag.selfClosing) {
		pieces.push(appended)
		pieces.text(`</${qualify(prefix, "sst")}>`)
		pieces.push(source.subarray(tag.end))

		return { pieces, root, appended, prefix, length }
	}

	const close = lastIndexOfText(source, "</", tag.end, source.length)
	const extension = lastIndexOfText(source, `<${qualify(prefix, "extLst")}`, tag.end, close)
	const at = extension >= 0 ? extension : close

	pieces.push(source.subarray(tag.end, at))
	pieces.push(appended)
	pieces.push(source.subarray(at))

	return { pieces, root, appended, prefix, length }
}
