import { readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import {
	OpcError,
	OpcPackage,
	addRelationships,
	bytesSource,
	editContentTypes,
	isValidPartName,
	memorySink,
	parseContentTypes,
	parseRelationships,
	partKey,
	partNameUri,
	relationshipsPartName,
	relativeTarget,
	resolvePartName,
	writeZip
} from "@filen/office/core/opc"
import { buildZip, sameBytes, text } from "./zipBuilder"

const RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const CONTENT_TYPES =
	'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="PNG" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="doc"/></Types>'

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)))
}

async function codeOf(run: () => Promise<unknown> | unknown): Promise<string | undefined> {
	try {
		await run()
	} catch (error) {
		return error instanceof OpcError ? error.code : `not an OpcError: ${String(error)}`
	}

	return undefined
}

function packageOf(names: string[]): Promise<OpcPackage> {
	return OpcPackage.open(
		bytesSource(
			buildZip([{ name: "[Content_Types].xml", data: text(CONTENT_TYPES) }, ...names.map(name => ({ name, data: text("<x/>") }))])
		)
	)
}

describe("part names", () => {
	it("compares names case-insensitively and percent-decoded", () => {
		expect(partKey("/Word/Document.XML")).toBe("word/document.xml")
		expect(partKey("word/media/%E5%9B%BE.png")).toBe(partKey("word/media/图.png"))
		expect(partKey("bad%zz")).toBe("bad%zz")
		expect(partKey("/Ä.xml")).toBe("Ä.xml")
	})

	it("accepts part names and refuses names that could escape or alias", () => {
		for (const name of ["word/document.xml", "[Content_Types].xml", "customXml/项目.xml", "_rels/.rels"]) {
			expect(isValidPartName(name), name).toBe(true)
		}

		for (const name of [
			"",
			"/word/x.xml",
			"word/",
			"word//x.xml",
			"word/./x.xml",
			"../x.xml",
			"word/x.",
			"word\\x.xml",
			"word%2Fx.xml",
			"a\u0001b"
		]) {
			expect(isValidPartName(name), name).toBe(false)
		}
	})

	it("resolves relationship targets against the source part", () => {
		expect(resolvePartName("word/document.xml", "styles.xml")).toBe("word/styles.xml")
		expect(resolvePartName("word/document.xml", "../customXml/item1.xml")).toBe("customXml/item1.xml")
		expect(resolvePartName("word/document.xml", "/word/media/a.png")).toBe("word/media/a.png")
		expect(resolvePartName("word/document.xml", "media/%E5%9B%BE.png#frag")).toBe("word/media/%E5%9B%BE.png")
		expect(partKey(resolvePartName("word/document.xml", "media/%E5%9B%BE.png") ?? "")).toBe(partKey("word/media/图.png"))
		expect(resolvePartName("", "word/document.xml")).toBe("word/document.xml")
		expect(resolvePartName("word/document.xml", "../../x.xml")).toBeUndefined()
		expect(resolvePartName("word/document.xml", "https://example.com/x")).toBeUndefined()
		expect(resolvePartName("word/document.xml", "#bookmark")).toBeUndefined()
	})

	it("decodes segments before resolving dots, and refuses encoded separators", () => {
		expect(resolvePartName("word/document.xml", "%2e%2e/%2e%2e/evil.xml")).toBeUndefined()
		expect(resolvePartName("word/document.xml", "%2E%2E/x.xml")).toBe("x.xml")
		expect(resolvePartName("word/document.xml", "media%2Fimg.png")).toBeUndefined()
		expect(resolvePartName("word/document.xml", "media%5Cimg.png")).toBeUndefined()
		expect(resolvePartName("word/document.xml", "bad%zz.png")).toBe("word/bad%zz.png")
	})

	it("decodes a name exactly once, so a literal percent sign stays one", async () => {
		const types = text(
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="a"/><Default Extension="rels" ContentType="r"/><Default Extension="png" ContentType="p"/></Types>'
		)
		const relationships = text(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="media/report%2520final.png"/></Relationships>'
		)
		const open = (mediaName: string): Promise<OpcPackage> =>
			OpcPackage.open(
				bytesSource(
					buildZip([
						{ name: "[Content_Types].xml", data: types },
						{ name: "word/document.xml", data: text("<a/>") },
						{ name: "word/_rels/document.xml.rels", data: relationships },
						{ name: mediaName, data: text("png") }
					])
				)
			)

		// The target means the part "report%20final.png": stored percent-encoded, that is "report%2520final.png".
		const encoded = await open("word/media/report%2520final.png")
		const target = (await encoded.relationships("word/document.xml")).byId("rId1")?.partName ?? ""

		expect(target).toBe("word/media/report%2520final.png")
		expect(sameBytes(await encoded.read(target), text("png"))).toBe(true)

		// A zip name "report%20final.png" is the part "report final.png", which the target does not name.
		const other = await open("word/media/report%20final.png")

		expect(other.has(target)).toBe(false)
		expect(other.has("word/media/report final.png")).toBe(true)
		expect(partNameUri("word/media/report%2520final.png")).toBe("/word/media/report%2520final.png")
		expect(relativeTarget("word/document.xml", "word/media/report%2520final.png")).toBe("media/report%2520final.png")
	})

	it("writes part names and relative targets", () => {
		expect(partNameUri("word/media/图 1.png")).toBe("/word/media/%E5%9B%BE%201.png")
		expect(partNameUri("[Content_Types].xml")).toBe("/[Content_Types].xml")
		expect(relativeTarget("word/document.xml", "word/media/图.png")).toBe("media/%E5%9B%BE.png")
		expect(relativeTarget("word/document.xml", "customXml/item1.xml")).toBe("../customXml/item1.xml")
		expect(relativeTarget("", "word/document.xml")).toBe("word/document.xml")

		for (const [source, part] of [
			["word/document.xml", "word/media/图 1.png"],
			["word/a/b.xml", "c/d.xml"],
			["", "x.xml"]
		] as const) {
			expect(partKey(resolvePartName(source, relativeTarget(source, part)) ?? "")).toBe(partKey(part))
		}
	})

	it("names the relationships part of a source", () => {
		expect(relationshipsPartName("word/document.xml")).toBe("word/_rels/document.xml.rels")
		expect(relationshipsPartName("")).toBe("_rels/.rels")
	})
})

describe("content types and relationships", () => {
	it("maps defaults by extension and overrides by part name", () => {
		const types = parseContentTypes(text(CONTENT_TYPES))

		expect(types.typeOf("word/document.xml")).toBe("doc")
		expect(types.typeOf("/WORD/document.xml")).toBe("doc")
		expect(types.typeOf("word/styles.xml")).toBe("application/xml")
		expect(types.typeOf("word/media/a.png")).toBe("image/png")
		expect(types.typeOf("word/media/a.gif")).toBeUndefined()
		expect(types.typeOf("word.d/noextension")).toBeUndefined()
	})

	it("refuses content types without the Types root", async () => {
		expect(await codeOf(() => parseContentTypes(text("<Types/>")))).toBe("invalidContentTypes")
		expect(
			await codeOf(() =>
				parseContentTypes(
					text('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="x"/></Types>')
				)
			)
		).toBe("invalidContentTypes")
	})

	it("reads relationships, keeping external targets unresolved", () => {
		const relationships = parseRelationships(
			text(
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
					`<Relationship Id="rId1" Type="${RELATIONSHIP}/image" Target="media/a%20b.png"/>` +
					`<Relationship Id="rId2" Type="${RELATIONSHIP}/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>` +
					`<Relationship Id="rId1" Type="${RELATIONSHIP}/image" Target="ignored.png"/>` +
					"</Relationships>"
			),
			"word/document.xml"
		)

		expect(relationships.byId("rId1")?.partName).toBe("word/media/a%20b.png")
		expect(relationships.byId("rId2")).toEqual({
			id: "rId2",
			type: `${RELATIONSHIP}/hyperlink`,
			target: "https://example.com/?a=1&b=2",
			external: true,
			partName: undefined
		})
		expect(relationships.byType(`${RELATIONSHIP}/image`).length).toBe(2)
		expect(relationships.all.length).toBe(3)
	})

	it("refuses relationships without their root or required attributes", async () => {
		expect(await codeOf(() => parseRelationships(text("<Relationships/>"), ""))).toBe("invalidRelationships")
		expect(
			await codeOf(() =>
				parseRelationships(
					text(
						'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x"/></Relationships>'
					),
					""
				)
			)
		).toBe("invalidRelationships")
	})
})

describe("content type and relationship edits", () => {
	it("adds and changes Defaults and Overrides in place", () => {
		const out = editContentTypes(text(CONTENT_TYPES), {
			defaults: [
				{ extension: "png", contentType: "image/x-png" },
				{ extension: "emf", contentType: "image/x-emf" }
			],
			overrides: [
				{ partName: "word/document.xml", contentType: "doc2" },
				{ partName: "word/media/图.xml", contentType: "x" }
			]
		})
		const types = parseContentTypes(out)
		const source = new TextDecoder().decode(out)

		expect(types.typeOf("a.PNG")).toBe("image/x-png")
		expect(types.typeOf("a.emf")).toBe("image/x-emf")
		expect(types.typeOf("word/document.xml")).toBe("doc2")
		expect(types.typeOf("word/media/图.xml")).toBe("x")
		// The new Default sits before the first Override; the new Override goes last.
		expect(source.indexOf('Extension="emf"')).toBeLessThan(source.indexOf("<Override"))
		expect(source.endsWith('<Override PartName="/word/media/%E5%9B%BE.xml" ContentType="x"/></Types>')).toBe(true)
	})

	it("turns repeated new entries into one, updated in place", () => {
		const out = new TextDecoder().decode(
			editContentTypes(text(CONTENT_TYPES), {
				defaults: [
					{ extension: "emf", contentType: "a" },
					{ extension: "EMF", contentType: "b" }
				],
				overrides: [
					{ partName: "word/x.xml", contentType: "c" },
					{ partName: "/WORD/X.xml", contentType: "d" }
				]
			})
		)

		expect(out.match(/Extension="emf"/gi)?.length).toBe(1)
		expect(out).toContain('<Default Extension="emf" ContentType="b"/>')
		expect(out.match(/PartName="\/word\/x.xml"/gi)?.length).toBe(1)
		expect(out).toContain('<Override PartName="/word/x.xml" ContentType="d"/>')
	})

	it("removes Overrides and keeps the document's own prefix", () => {
		const prefixed = text(
			'<t:Types xmlns:t="http://schemas.openxmlformats.org/package/2006/content-types"><t:Override PartName="/a.xml" ContentType="a"/></t:Types>'
		)
		const out = new TextDecoder().decode(
			editContentTypes(prefixed, { removeOverrides: ["A.xml"], overrides: [{ partName: "b.xml", contentType: "b" }] })
		)

		expect(out).toBe(
			'<t:Types xmlns:t="http://schemas.openxmlformats.org/package/2006/content-types"><t:Override PartName="/b.xml" ContentType="b"/></t:Types>'
		)
	})

	it("adds relationships with fresh ids, creating the part when there is none", () => {
		const existing = text(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="t" Target="a.xml"/><Relationship Id="rId5x" Type="t" Target="b.xml"/></Relationships>'
		)
		const added = addRelationships(existing, [
			{ type: `${RELATIONSHIP}/image`, target: "media/a&b.png" },
			{ type: `${RELATIONSHIP}/hyperlink`, target: "https://example.com/?a=1&b=2", external: true }
		])
		const parsed = parseRelationships(added.bytes, "word/document.xml")

		expect(added.ids).toEqual(["rId4", "rId5"])
		expect(parsed.byId("rId4")?.partName).toBe("word/media/a&b.png")
		expect(parsed.byId("rId5")?.external).toBe(true)
		expect(parsed.byId("rId5")?.target).toBe("https://example.com/?a=1&b=2")
		expect(
			new TextDecoder()
				.decode(added.bytes)
				.startsWith('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3"')
		).toBe(true)

		const created = addRelationships(null, [{ type: "t", target: "x.xml" }])

		expect(created.ids).toEqual(["rId1"])
		expect(parseRelationships(created.bytes, "").byId("rId1")?.partName).toBe("x.xml")
	})

	it("numbers new relationships past ids too large to count on, and always finds one", () => {
		const existing = text(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="t" Target="a.xml"/>' +
				'<Relationship Id="rId9007199254740992" Type="t" Target="b.xml"/><Relationship Id="rId99999999999999999999999" Type="t" Target="c.xml"/>' +
				'<Relationship Id="rId4" Type="t" Target="d.xml"/></Relationships>'
		)
		const added = addRelationships(existing, [
			{ type: "t", target: "e.xml" },
			{ type: "t", target: "f.xml" },
			{ type: "t", target: "g.xml" }
		])
		const parsed = parseRelationships(added.bytes, "")

		expect(added.ids).toEqual(["rId5", "rId6", "rId7"])
		expect(parsed.all.map(relationship => relationship.id)).toEqual([
			"rId3",
			"rId9007199254740992",
			"rId99999999999999999999999",
			"rId4",
			"rId5",
			"rId6",
			"rId7"
		])

		// Counted on from the largest id that can be: each new one still a plain integer, past it.
		const edge = text(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4503599627370496" Type="t" Target="a.xml"/></Relationships>'
		)

		expect(
			addRelationships(edge, [
				{ type: "t", target: "b.xml" },
				{ type: "t", target: "c.xml" }
			]).ids
		).toEqual(["rId4503599627370497", "rId4503599627370498"])
	})
})

describe("OpcPackage", () => {
	it("opens a document and follows its relationships", async () => {
		const opc = await OpcPackage.open(bytesSource(fixture("07-chart-customxml-unknown.docx")))
		const packageRelationships = await opc.relationships("")
		const main = packageRelationships.byType(`${RELATIONSHIP}/officeDocument`)[0]?.partName ?? ""
		const documentRelationships = await opc.relationships(main)
		const types = await opc.contentTypes()

		expect(main).toBe("word/document.xml")
		expect(types.typeOf(main)).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")
		expect(documentRelationships.byId("rIdCustom1")?.partName).toBe("customXml/item1.xml")
		expect(documentRelationships.byId("rIdChart1")?.partName).toBe("word/charts/chart1.xml")

		for (const relationship of documentRelationships.all) {
			expect(opc.has(relationship.partName ?? ""), relationship.target).toBe(true)
		}

		expect((await opc.relationships("word/styles.xml")).all).toEqual([])
		expect(opc.has("WORD/Document.xml")).toBe(true)
		expect(opc.has("word/")).toBe(false)
		expect(await opc.relationships(main)).toBe(documentRelationships)

		const document = await opc.xml(main)

		expect(document.localName(document.documentElement())).toBe("document")
	})

	it("refuses packages with invalid, colliding or missing parts", async () => {
		expect(await codeOf(() => packageOf(["word/../x.xml"]))).toBe("invalidPartName")
		expect(await codeOf(() => packageOf(["word/Document.xml", "word/document.xml"]))).toBe("duplicatePart")
		expect(await codeOf(() => packageOf(["word/%41.xml", "word/A.xml"]))).toBe("duplicatePart")
		expect(await codeOf(() => OpcPackage.open(bytesSource(buildZip([{ name: "word/document.xml", data: text("<x/>") }]))))).toBe(
			"missingPart"
		)
		expect(await codeOf(async () => (await packageOf(["a.xml"])).read("b.xml"))).toBe("missingPart")
	})

	it("plans saves by OPC name and refuses colliding additions", async () => {
		const opc = await OpcPackage.open(bytesSource(fixture("01-plain.docx")))
		const replacement = text("<w:document xmlns:w='urn:w'/>")
		const contentTypes = editContentTypes(await opc.read("[Content_Types].xml"), {
			defaults: [{ extension: "QQQ", contentType: "application/x-q" }]
		})

		expect(await codeOf(() => opc.plan({ add: [{ name: "word/media/filen-1.qqq", bytes: text("png"), compress: false }] }))).toBe(
			"missingContentType"
		)

		const plan = await opc.plan({
			replace: [
				{ name: "/WORD/document.xml", bytes: replacement },
				{ name: "[Content_Types].xml", bytes: contentTypes }
			],
			add: [{ name: "word/media/filen-1.qqq", bytes: text("png"), compress: false }]
		})
		const sink = memorySink()

		await writeZip(plan, opc.zip, sink)

		const files = unzipSync(sink.bytes())

		expect(sameBytes(files["word/document.xml"], replacement)).toBe(true)
		expect(sameBytes(files["word/media/filen-1.qqq"], text("png"))).toBe(true)
		expect(await codeOf(() => opc.plan({ add: [{ name: "Word/Styles.xml", bytes: text("x") }] }))).toBe("duplicatePart")
		expect(await codeOf(() => opc.plan({ add: [{ name: "../x", bytes: text("x") }] }))).toBe("invalidPartName")
		expect(await codeOf(() => opc.plan({ replace: [{ name: "missing.xml", bytes: text("x") }] }))).toBe("missingPart")
	})
})
