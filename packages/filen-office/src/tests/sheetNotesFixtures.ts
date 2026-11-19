import { unzipSync, zipSync } from "fflate"
import { bytesSource } from "../core/opc/index"
import { openXlsxSession } from "../core/sheet/commands"
import type { SheetEvent, SheetSessionApi, SheetSessionSettings } from "../core/sheet/protocol"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { IMMEDIATE, SML, buildFixture } from "./sheetSessionFixtures"
import type { Fixture } from "./xlsxWriteFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"

// Workbooks with notes, threaded comments and hyperlinks, and sessions over them.

export { changeOf, refusalOf } from "./sheetSessionFixtures"

export const VML_HEAD =
	'<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
	'<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>' +
	'<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'

export function noteShape(id: number, row: number, col: number, shown = false): string {
	return (
		`<v:shape id="_x0000_s${String(id)}" type="#_x0000_t202" style="position:absolute;width:108pt;height:59.25pt;z-index:1;visibility:${shown ? "visible" : "hidden"}" fillcolor="#ffffe1">` +
		`<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${String(col + 1)}, 15, 0, 2, ${String(col + 3)}, 15, 4, 4</x:Anchor>` +
		`<x:AutoFill>False</x:AutoFill><x:Row>${String(row)}</x:Row><x:Column>${String(col)}</x:Column>${shown ? "<x:Visible/>" : ""}</x:ClientData></v:shape>`
	)
}

export function commentsPart(authors: readonly string[], comments: readonly { ref: string; author: number; text: string }[]): string {
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${SML}"><authors>${authors.map(author => `<author>${author}</author>`).join("")}</authors>` +
		`<commentList>${comments
			.map(
				comment =>
					`<comment ref="${comment.ref}" authorId="${String(comment.author)}" shapeId="0"><text><r><rPr><b/><sz val="9"/></rPr><t>${authors[comment.author] ?? ""}:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\n${comment.text}</t></r></text></comment>`
			)
			.join("")}</commentList></comments>`
	)
}

// A sheet with notes on B2 and D5 (shown), and a second sheet with none.
export const NOTES: Fixture = {
	sheets: [
		{
			name: "One",
			body: '<sheetData><row r="2"><c r="B2"><v>1</v></c></row></sheetData><legacyDrawing r:id="rId2"/>',
			rels: relationship("rId1", "comments", "../comments1.xml") + relationship("rId2", "vmlDrawing", "../drawings/vmlDrawing1.vml")
		},
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData>' }
	],
	parts: {
		"xl/comments1.xml": {
			text: commentsPart(
				["Ann"],
				[
					{ ref: "B2", author: 0, text: "first note" },
					{ ref: "D5", author: 0, text: "second" }
				]
			),
			type: TYPES.comments
		},
		"xl/drawings/vmlDrawing1.vml": { text: `${VML_HEAD}${noteShape(1025, 1, 1)}${noteShape(1026, 4, 3, true)}</xml>`, type: TYPES.vml }
	}
}

export async function openAnnotated(
	fixture: Fixture | Uint8Array,
	settings: SheetSessionSettings = { author: "Jan" }
): Promise<{ session: SheetSessionApi; sheets: number[]; events: SheetEvent[]; bytes: Uint8Array }> {
	const bytes = fixture instanceof Uint8Array ? fixture : buildFixture(fixture)
	const events: SheetEvent[] = []
	const opened = await openXlsxSession(bytesSource(bytes.slice()), { kind: "xlsx", slicing: IMMEDIATE, settings }, event =>
		events.push(event)
	)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	return { session: opened.session, sheets: opened.info.sheets.map(sheet => sheet.id), events, bytes }
}

// Lets loads started beside the open land.
export async function settle(): Promise<void> {
	for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))
}

export function entries(bytes: Uint8Array): Record<string, string> {
	return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, decodeUtf8(data)]))
}

// A built workbook with more workbook relationships and parts (the fixture builder gives the workbook its sheets'
// and styles' only).
export function withWorkbookParts(
	bytes: Uint8Array,
	relationships: string,
	parts: Record<string, { text: string; type: string }>
): Uint8Array {
	const files: Record<string, Uint8Array> = unzipSync(bytes)
	const rels = decodeUtf8(files["xl/_rels/workbook.xml.rels"] ?? new Uint8Array(0))
	const types = decodeUtf8(files["[Content_Types].xml"] ?? new Uint8Array(0))

	files["xl/_rels/workbook.xml.rels"] = encodeUtf8(rels.replace("</Relationships>", `${relationships}</Relationships>`))
	files["[Content_Types].xml"] = encodeUtf8(
		types.replace(
			"</Types>",
			`${Object.entries(parts)
				.map(([name, part]) => `<Override PartName="/${name}" ContentType="${part.type}"/>`)
				.join("")}</Types>`
		)
	)

	for (const [name, part] of Object.entries(parts)) files[name] = encodeUtf8(part.text)

	return zipSync(files)
}

export const range = (startRow: number, startCol: number, endRow = startRow, endCol = startCol) => ({ startRow, startCol, endRow, endCol })
