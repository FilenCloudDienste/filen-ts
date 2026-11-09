import { describe, expect, it } from "vitest"
import { markerCounts, moveStarts } from "./fuzz/harness"
import { droppedParts, repeatedIds, type PackageView } from "./fuzz/independentReader"

const encode = (xml: string): Uint8Array => new TextEncoder().encode(xml)
const control = (id: string): string => `<w:sdt><w:sdtPr><w:id w:val="${id}"/></w:sdtPr><w:sdtContent><w:p/></w:sdtContent></w:sdt>`
const textBox = (inner: string): string =>
	`<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${inner}</w:drawing></mc:Choice><mc:Fallback><w:pict>${inner}</w:pict></mc:Fallback></mc:AlternateContent>`

describe("the paged fuzz's independent reader", () => {
	it("counts ids a text box's fallback repeats from its choice once, as Word writes them", () => {
		expect(repeatedIds(encode(`<w:body>${textBox(control("7"))}</w:body>`))).toEqual(new Map())
		// Nested in another text box's fallback, still the fallback's.
		expect(repeatedIds(encode(`<w:body>${textBox(control("7") + `<mc:Fallback>${control("7")}</mc:Fallback>`)}</w:body>`))).toEqual(
			new Map()
		)
	})

	it("counts ids repeated outside fallbacks", () => {
		expect(repeatedIds(encode(`<w:body>${control("7")}${textBox(control("7"))}</w:body>`))).toEqual(new Map([["sdt:7", 2]]))
		expect(repeatedIds(encode('<w:body><w:p w14:paraId="0A"/><mc:Fallback/><w:p w14:paraId="0A"/></w:body>'))).toEqual(
			new Map([["paraId:0A", 2]])
		)
	})
})

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const TYPES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const rels = (...relationships: [id: string, type: string, target: string][]): string =>
	`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships
		.map(([id, type, target]) => `<Relationship Id="${id}" Type="${TYPES}/${type}" Target="${target}"/>`)
		.join("")}</Relationships>`
const body = (inner: string): string =>
	`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R_NS}" ` +
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
	`xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>${inner}</w:body></w:document>`
const view = (entries: Record<string, string>): PackageView => ({
	names: Object.keys(entries),
	read: name => (entries[name] === undefined ? undefined : encode(entries[name]))
})
const picture = '<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>'
const source = {
	"word/document.xml": body(picture),
	"word/_rels/document.xml.rels": rels(["rId1", "styles", "styles.xml"], ["rId5", "image", "media/image1.png"]),
	"word/styles.xml": "<w:styles/>",
	"word/media/image1.png": "png"
}

describe("the damage fuzz's independent reader on parts a save leaves out", () => {
	it("lets a part go with the last relationship to it, once nothing uses that relationship", () => {
		const output = {
			"word/document.xml": body("<w:p/>"),
			"word/_rels/document.xml.rels": rels(["rId1", "styles", "styles.xml"]),
			"word/styles.xml": "<w:styles/>"
		}

		expect(droppedParts(view(source), view(output))).toEqual(new Set(["word/media/image1.png"]))
		// VML names its picture by o:relid.
		expect(
			droppedParts(
				view({ ...source, "word/document.xml": body('<w:p><w:r><w:pict><v:imagedata o:relid="rId5"/></w:pict></w:r></w:p>') }),
				view(output)
			)
		).toEqual(new Set(["word/media/image1.png"]))
	})

	it("lets a chart go with its relationships part and the parts only the chart pointed at", () => {
		const chart = {
			"word/document.xml": body('<w:p><w:r><w:drawing><c:chart r:id="rId5"/></w:drawing></w:r></w:p>'),
			"word/_rels/document.xml.rels": rels(["rId5", "chart", "charts/chart1.xml"]),
			"word/charts/chart1.xml": "<c:chartSpace/>",
			"word/charts/_rels/chart1.xml.rels": rels(["rId1", "package", "../embeddings/Sheet%201.xlsx"]),
			"word/embeddings/Sheet 1.xlsx": "xlsx"
		}
		const output = { "word/document.xml": body("<w:p/>"), "word/_rels/document.xml.rels": rels() }

		expect(droppedParts(view(chart), view(output))).toEqual(
			new Set(["word/charts/chart1.xml", "word/charts/_rels/chart1.xml.rels", "word/embeddings/Sheet 1.xlsx"])
		)
	})

	it("lets a SmartArt's drawing go with its data, which names it", () => {
		const data =
			'<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId10"/></dgm:dataModel>'
		const smartArt = {
			"word/document.xml": body(
				'<w:p><w:r><w:drawing><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId6"/></w:drawing></w:r></w:p>'
			),
			"word/_rels/document.xml.rels": rels(
				["rId6", "diagramData", "diagrams/data1.xml"],
				["rId10", "diagramDrawing", "diagrams/drawing1.xml"]
			),
			"word/diagrams/data1.xml": data,
			"word/diagrams/drawing1.xml": "<dsp:drawing/>"
		}

		expect(droppedParts(view(smartArt), view({ "word/document.xml": body("<w:p/>"), "word/_rels/document.xml.rels": rels() }))).toEqual(
			new Set(["word/diagrams/data1.xml", "word/diagrams/drawing1.xml"])
		)
		// The data stays, so its drawing must too.
		const { "word/diagrams/drawing1.xml": _drawing, ...withoutDrawing } = smartArt

		expect(
			droppedParts(
				view(smartArt),
				view({ ...withoutDrawing, "word/_rels/document.xml.rels": rels(["rId6", "diagramData", "diagrams/data1.xml"]) })
			)
		).toEqual(new Set())
	})

	it("keeps a part markup still uses, one a relationship still targets, and one nothing pointed at", () => {
		const { "word/media/image1.png": _image, ...withoutImage } = source

		// The relationship went, but the picture is still there.
		expect(
			droppedParts(view(source), view({ ...withoutImage, "word/_rels/document.xml.rels": rels(["rId1", "styles", "styles.xml"]) }))
		).toEqual(new Set())
		// The relationship stayed.
		expect(droppedParts(view(source), view({ ...withoutImage, "word/document.xml": body("<w:p/>") }))).toEqual(new Set())
		// Another part still points at the picture.
		expect(
			droppedParts(
				view(source),
				view({
					"word/document.xml": body("<w:p/>"),
					"word/_rels/document.xml.rels": rels(["rId1", "styles", "styles.xml"]),
					"word/styles.xml": "<w:styles/>",
					"word/_rels/header1.xml.rels": rels(["rId1", "image", "media/image1.png"])
				})
			)
		).toEqual(new Set())
		// No relationship ever pointed at the styles part.
		const { "word/styles.xml": _styles, ...withoutStyles } = source

		expect(
			droppedParts(
				view({ ...source, "word/_rels/document.xml.rels": rels(["rId5", "image", "media/image1.png"]) }),
				view(withoutStyles)
			)
		).toEqual(new Set())
	})
})

describe("the damage fuzz's marker counts", () => {
	const written = (id: string, name = "move6"): Uint8Array =>
		encode(
			`<w:moveFromRangeStart w:id="${id}" w:name="${name}" w:author="A"/><w:moveFromRangeEnd w:id="${id}"/>` +
				`<w:bookmarkStart w:id="${id}" w:name="b"/><w:bookmarkEnd w:id="${id}"/>`
		)

	it("knows a new move range by its name, which the save keeps while it writes a w:id of its own", () => {
		const source = moveStarts(encode('<w:moveFromRangeStart w:id="7" w:name="move1" w:author="A"/>'))

		expect(source).toEqual(new Set(["moveFromRangeStart:7:move1"]))
		expect(markerCounts(written("2"), new Map(), source)).toEqual(
			new Map([
				["moveFromRangeStart:name:move6", 1],
				["bookmarkStart:2", 1],
				["bookmarkEnd:2", 1]
			])
		)
		// One the source has keeps its w:id, and is known by it.
		expect(markerCounts(written("7", "move1"), new Map(), source).get("moveFromRangeStart:7")).toBe(1)
		// Source bytes: every marker by its w:id.
		expect(markerCounts(written("2")).get("moveFromRangeStart:2")).toBe(1)
	})
})
