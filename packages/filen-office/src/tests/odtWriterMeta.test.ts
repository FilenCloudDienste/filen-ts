import { describe, expect, it } from "vitest"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { decodeUtf8, encodeUtf8 } from "@filen/office/core/xml"
import { metaOnSave } from "../core/odf/meta"
import { proveOdtWritten, writeOdt } from "../core/odt/write/writer"
import { ODF_NS, odtBytes } from "./odtFixtures"
import { editOdt, odtEditsOf } from "./odtWriteFixtures"
import { paragraphs } from "./rtfWriteFixtures"

// A save updates meta.xml as ODF producers do (ODF 1.3 Part 3 §4.3.2): dc:date the save time, meta:editing-cycles one
// more, the statistics dropped (they would be stale); the generator and the people named left as they were.

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5)
const DATE = "2026-01-02T03:04:05.000Z"

function metaXml(inner: string, open = "<office:meta>", close = "</office:meta>"): string {
	return `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${ODF_NS} office:version="1.3">${open}${inner}${close}</office:document-meta>`
}

const STATS = '<meta:document-statistic meta:page-count="3" meta:paragraph-count="1" meta:word-count="2" meta:character-count="9"/>'
const META = metaXml(
	"<meta:generator>LibreOffice/7.6</meta:generator><meta:initial-creator>A</meta:initial-creator><dc:creator>B</dc:creator>" +
		"<dc:date>2020-05-06T07:08:09.123</dc:date><meta:editing-cycles>4</meta:editing-cycles><meta:editing-duration>PT1M</meta:editing-duration>" +
		STATS
)

async function entry(bytes: Uint8Array, name: string): Promise<string | undefined> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const found = archive.get(name)

	return found === undefined ? undefined : decodeUtf8(await archive.read(found))
}

async function savedWith(
	meta: string | undefined
): Promise<{ bytes: Uint8Array; proof: string | undefined; check: () => Promise<{ span: boolean; whole: string }> }> {
	const bytes = odtBytes({
		body: "<text:p>One para</text:p><text:p>Two para</text:p>",
		extra: meta === undefined ? [] : [{ name: "meta.xml", data: encodeUtf8(meta) }]
	})
	const editing = await editOdt(bytes)
	const first = paragraphs(editing.session.state.doc)[0]

	if (first === undefined) throw new Error("no paragraph")

	editing.session.dispatch(editing.session.state.tr.insertText("Z", first.pos + 1))

	const edits = await odtEditsOf(editing)
	const written = await writeOdt(editing.source, edits, { now: () => NOW })

	return { bytes: written.bytes, proof: written.proof, check: () => proveOdtWritten(editing.source, edits, written.bytes) }
}

describe("ODT writer meta.xml", () => {
	it("dates the save, counts the editing cycle and drops the stale statistics", async () => {
		const { bytes, proof, check } = await savedWith(META)
		const meta = await entry(bytes, "meta.xml")

		expect(meta).toBe(
			metaXml(
				"<meta:generator>LibreOffice/7.6</meta:generator><meta:initial-creator>A</meta:initial-creator><dc:creator>B</dc:creator>" +
					`<dc:date>${DATE}</dc:date><meta:editing-cycles>5</meta:editing-cycles><meta:editing-duration>PT1M</meta:editing-duration>`
			)
		)
		// The span proof checks the rewritten meta.xml instead of falling back to the whole file's.
		expect(proof).toBe("span")
		expect(await check()).toEqual({ span: true, whole: "done" })
	})

	it("adds dc:date and meta:editing-cycles where the file has none", async () => {
		const { bytes } = await savedWith(metaXml("", "<office:meta/>", ""))

		expect(await entry(bytes, "meta.xml")).toBe(metaXml(`<dc:date>${DATE}</dc:date><meta:editing-cycles>1</meta:editing-cycles>`))
	})

	it("leaves a file without meta.xml without one", async () => {
		const { bytes } = await savedWith(undefined)

		expect(await entry(bytes, "meta.xml")).toBeUndefined()
	})

	it("copies a malformed meta.xml as it was rather than refusing the save", async () => {
		const broken = metaXml("<dc:date>2020</dc:date>").replace("</office:meta>", "")
		const { bytes } = await savedWith(broken)

		expect(await entry(bytes, "meta.xml")).toBe(broken)
	})

	it("restarts a count it cannot read, binds the prefixes the file uses and declares those it lacks", () => {
		const own =
			'<x:document-meta xmlns:x="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:m="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">' +
			"<x:meta><m:editing-cycles>many</m:editing-cycles></x:meta></x:document-meta>"
		const out = metaOnSave(encodeUtf8(own), DATE)

		expect(out === undefined ? undefined : decodeUtf8(out)).toBe(
			'<x:document-meta xmlns:x="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:m="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">' +
				`<x:meta><m:editing-cycles>1</m:editing-cycles><dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${DATE}</dc:date></x:meta></x:document-meta>`
		)
	})

	it("leaves a meta.xml that is not an ODF meta document alone", () => {
		expect(metaOnSave(encodeUtf8("<a><meta/></a>"), DATE)).toBeUndefined()
	})
})
