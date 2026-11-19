import { NodeKind, type XmlDocument } from "../../../xml/index"
import { Ns } from "../../model/namespaces"
import { partReader, type PartReader } from "../../model/reader"
import { DocxVerifyError } from "../failure"
import type { CheckedPart, CheckInput, DocxCheck } from "./index"

// Tracked change shapes in rewritten story markup: deleted text (w:delText, w:delInstrText) only inside a
// deletion or a move away, and every revision element the save added (an id the source does not have) with
// a non-empty author, an ISO 8601 date when it has one, and, for the run wrappers, content. A source change
// that moved with its paragraph mark is written as the source has it, w:id included. Unique revision ids are
// counted by gate 2 itself (verify.ts).

const DELETED_TEXT: ReadonlySet<string> = new Set(["delText", "delInstrText"])
const DELETIONS: ReadonlySet<string> = new Set(["del", "moveFrom"])
const RUN_WRAPPERS: ReadonlySet<string> = new Set(["ins", "del", "moveFrom", "moveTo"])
// Containers whose w:ins / w:del mark something (a paragraph mark, a row, a numbering) rather than wrap runs.
const MARKERS_OF: ReadonlySet<string> = new Set(["rPr", "trPr", "numPr", "tcPr"])
// Revision elements: gate 2 counts their w:id as revision:<id> (verify.ts, a range's end shares its start's id),
// and a new one must have an author and a date as above.
export const REVISION_ELEMENTS: ReadonlySet<string> = new Set([
	"ins",
	"del",
	"moveFrom",
	"moveTo",
	"rPrChange",
	"pPrChange",
	"sectPrChange",
	"tblPrChange",
	"trPrChange",
	"tcPrChange",
	"tblGridChange",
	"tblPrExChange",
	"numberingChange",
	"cellIns",
	"cellDel",
	"cellMerge",
	"moveFromRangeStart",
	"moveToRangeStart"
])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/

function fail(message: string): never {
	throw new DocxVerifyError("content", message)
}

function isW(reader: PartReader, node: number, names: ReadonlySet<string>): boolean {
	return reader.group(node) === Ns.W && names.has(reader.document.localName(node))
}

function insideDeletion(document: XmlDocument, reader: PartReader, node: number): boolean {
	for (let at = document.parent(node); at >= 0; at = document.parent(at)) if (isW(reader, at, DELETIONS)) return true

	return false
}

function storyPart(input: CheckInput, part: CheckedPart): void {
	const document = part.document
	const reader = partReader(document)

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || reader.group(node) !== Ns.W) continue

		const local = document.localName(node)

		if (DELETED_TEXT.has(local)) {
			if (!insideDeletion(document, reader, node)) fail(`${part.name}: w:${local} outside a deletion`)

			continue
		}

		if (!REVISION_ELEMENTS.has(local)) continue

		const id = reader.attr(node, Ns.W, "id")

		// What the source has is checked where it came from.
		if (id === undefined || input.source(`revision:${id}`) > 0) continue

		// w:tblGridChange is CT_Markup: an id, no author.
		if (local !== "tblGridChange" && (reader.attr(node, Ns.W, "author") ?? "") === "")
			fail(`${part.name}: a new w:${local} has no author`)

		const date = reader.attr(node, Ns.W, "date")

		if (date !== undefined && !ISO_DATE.test(date)) fail(`${part.name}: a new w:${local} has the date ${date}`)

		const parent = document.parent(node)

		if (RUN_WRAPPERS.has(local) && !(parent >= 0 && isW(reader, parent, MARKERS_OF)) && document.firstChildElement(node) < 0)
			fail(`${part.name}: a new w:${local} holds nothing`)
	}
}

export const revisionChecks: readonly DocxCheck[] = [
	{
		part(input, part) {
			if (part.part !== undefined) storyPart(input, part)
		}
	}
]
