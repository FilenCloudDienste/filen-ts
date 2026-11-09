import { readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { newDiagramData, withDrawingReference } from "../core/smartart/edit"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { smartartCapability } from "../dom/presentation/engine/smartart"
import { chartData } from "../dom/presentation/engine/chart"
import { clipPartNames, importSlidesOp, pasteShapesOp, type ShapeClip } from "../core/presentation/edit/clip"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { DeckOp, ImportedSlide, RawPart } from "../core/presentation/edit/ops"
import { importedSlideParts } from "../core/pptx/write/importSlide"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { clip, clipParts, clipSlides } from "../dom/presentation/engine/clip"
import { viewCapability } from "../dom/presentation/engine/view"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences, openDeck } from "./pptxWriteFixtures"

// Cut, Copy and Paste of the objects that own parts (charts with their workbooks, SmartArt, embedded objects, ink):
// the paste gives the slide copies of its own, within a deck and into another, and the saves that follow pass the
// writer's proof gates with every part and relationship in place.

type Drive = Awaited<ReturnType<typeof driveSession>>

const CELLS = sampleChartCells({ categories: ["A", "B"], series: ["North", "South"] })
const ASSETS = join(import.meta.dirname, "fixtures", "smartart")
const asset = (file: string): string => readFileSync(join(ASSETS, file), "utf8")
const DIAGRAM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const DSP = "http://schemas.microsoft.com/office/drawing/2008/diagram"
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77,
	0x53, 0xde, 0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 3, 1, 1, 0, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0,
	0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])
const RELS = (entries: string): string =>
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`

function pic(id: number, name: string, embed: string, box: string): string {
	return (
		`<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/>` +
		`<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${box}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
	)
}

// A slide holding a diagram (id 4, a picture in its data, with its drawing cache), an embedded object (id 7, its
// preview picture), ink (id 8, PowerPoint's mc:AlternateContent with its picture fallback) and ink as a bare content
// part (id 9).
function objectsDeck(): Uint8Array {
	const data = newDiagramData(["One", "Two"], { layout: { uniqueId: "urn:filen:smartart:layout:row", category: "list" } }).replace(
		"<dgm:spPr/>",
		'<dgm:spPr><a:blipFill xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="rId1"/></a:blipFill></dgm:spPr>'
	)
	const withCache = new TextDecoder().decode(withDrawingReference(parseXml(encodeUtf8(data)), "rId15"))
	const drawing = `<dsp:drawing xmlns:dsp="${DSP}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/></dsp:spTree></dsp:drawing>`
	const diagram =
		'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Diagram 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
		'<p:xfrm><a:off x="100000" y="900000"/><a:ext cx="6000000" cy="3000000"/></p:xfrm>' +
		`<a:graphic><a:graphicData uri="${DIAGRAM_URI}"><dgm:relIds xmlns:dgm="${DIAGRAM_URI}" r:dm="rId11" r:lo="rId12" r:qs="rId13" r:cs="rId14"/></a:graphicData></a:graphic></p:graphicFrame>`
	const box = xfrm(200000, 200000, 1000000, 800000)
	const ole =
		'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Object 6"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
		'<p:xfrm><a:off x="200000" y="200000"/><a:ext cx="1000000" cy="800000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">' +
		`<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj name="Packager Shell Object" r:id="rId21" imgW="1000" imgH="800" progId="Package"><p:embed/></p:oleObj></mc:Choice>` +
		`<mc:Fallback><p:oleObj name="Packager Shell Object" r:id="rId21" imgW="1000" imgH="800" progId="Package"><p:embed/>${pic(0, "", "rId22", box)}</p:oleObj></mc:Fallback></mc:AlternateContent>` +
		"</a:graphicData></a:graphic></p:graphicFrame>"
	const ink =
		`<mc:AlternateContent xmlns:mc="${MC}" xmlns:p14="${P14}"><mc:Choice Requires="p14"><p:contentPart p14:bwMode="auto" r:id="rId31"><p14:nvContentPartPr><p14:cNvPr id="8" name="Ink 7"/><p14:cNvContentPartPr/><p14:nvPr/></p14:nvContentPartPr>` +
		`<p14:xfrm><a:off x="300000" y="300000"/><a:ext cx="500000" cy="500000"/></p14:xfrm></p:contentPart></mc:Choice><mc:Fallback>${pic(8, "Ink 7", "rId32", xfrm(300000, 300000, 500000, 500000))}</mc:Fallback></mc:AlternateContent>`
	const bareInk =
		`<p:contentPart xmlns:p14="${P14}" p14:bwMode="auto" r:id="rId33"><p14:nvContentPartPr><p14:cNvPr id="9" name="Ink 8"/><p14:cNvContentPartPr/><p14:nvPr/></p14:nvContentPartPr>` +
		'<p14:xfrm><a:off x="900000" y="300000"/><a:ext cx="500000" cy="500000"/></p14:xfrm></p:contentPart>'
	const inkml = '<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:trace>0 0, 10 10</inkml:trace></inkml:ink>'

	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "TextBox 1", undefined, xfrm(100000, 100000, 3000000, 500000), body(para("One"))) + diagram + ole + ink + bareInk,
				rels: [
					["rId11", "diagramData", "../diagrams/data1.xml"],
					["rId12", "diagramLayout", "../diagrams/layout1.xml"],
					["rId13", "diagramQuickStyle", "../diagrams/quickStyle1.xml"],
					["rId14", "diagramColors", "../diagrams/colors1.xml"],
					["rId15", "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing", "../diagrams/drawing1.xml"],
					["rId21", "oleObject", "../embeddings/oleObject1.bin"],
					["rId22", "image", "../media/image2.png"],
					["rId31", "customXml", "../ink/ink1.xml"],
					["rId32", "image", "../media/image3.png"],
					["rId33", "customXml", "../ink/ink2.xml"]
				]
			},
			{ shapes: sp(2, "TextBox 1", undefined, xfrm(100000, 100000, 3000000, 500000), body(para("Two"))) }
		],
		defaults:
			'<Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>',
		parts: {
			"ppt/diagrams/data1.xml": { data: withCache, type: "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml" },
			"ppt/diagrams/_rels/data1.xml.rels": {
				data: RELS(
					'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
				)
			},
			"ppt/diagrams/layout1.xml": {
				data: asset("test-row.xml"),
				type: "application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"
			},
			"ppt/diagrams/quickStyle1.xml": {
				data: asset("test-style-flat.xml"),
				type: "application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml"
			},
			"ppt/diagrams/colors1.xml": {
				data: asset("test-colors-accent.xml"),
				type: "application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml"
			},
			"ppt/diagrams/drawing1.xml": { data: drawing, type: "application/vnd.ms-office.drawingml.diagramDrawing+xml" },
			"ppt/media/image1.png": { data: PNG },
			"ppt/media/image2.png": { data: PNG },
			"ppt/media/image3.png": { data: PNG },
			"ppt/embeddings/oleObject1.bin": { data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) },
			"ppt/ink/ink1.xml": { data: inkml, type: "application/inkml+xml" },
			"ppt/ink/ink2.xml": { data: inkml, type: "application/inkml+xml" }
		}
	})
}

function blank(text = "x"): Uint8Array {
	return buildPptx({
		slides: [
			{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(text))) },
			{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("two"))) }
		]
	})
}

function nodeOf(d: Drive, slide: SlideRef): SlideNode {
	return d.session.deck.nodes.get(slide) ?? ({ shapes: [] } as unknown as SlideNode)
}

function frames(d: Drive, slide: SlideRef, kind: string): ShapeNode[] {
	return nodeOf(d, slide).shapes.filter(shape => shape.frame?.kind === kind || (kind === "ink" && shape.kind === "ink"))
}

async function copied(d: Drive, slide: SlideRef, ids: readonly number[]): Promise<ShapeClip> {
	const result = await clip(d.context, { kind: "shapes", slide, shapes: ids })

	if (!result.ok || result.clip.kind !== "shapes") throw new Error(`clip: ${JSON.stringify(result)}`)

	return result.clip
}

function boxes(d: Drive, slide: SlideRef): Xfrm[] {
	return nodeOf(d, slide).shapes.flatMap(shape => (shape.xfrm === undefined ? [] : [shape.xfrm]))
}

// A paste into another deck brings the bytes of the pictures the clip names from the deck it came from.
async function pasted(d: Drive, made: ShapeClip, slide: SlideRef, from?: Drive): Promise<DeckOp> {
	const parts = from === undefined ? undefined : await clipParts(from.context, clipPartNames(made))

	if (parts !== undefined && !parts.ok) throw new Error(`parts: ${parts.refusal}`)

	const op = pasteShapesOp(made, {
		slide,
		boxes: boxes(d, slide),
		sameDeck: from === undefined,
		format: "pptx",
		...(parts === undefined ? {} : { parts: new Map(parts.parts.map(part => [part.name, part] as const)) })
	})

	if (typeof op === "string") throw new Error(`paste: ${op}`)

	return op
}

async function saved(d: Drive): Promise<Uint8Array> {
	const out = await d.save()

	if (out.result.kind !== "written" || out.bytes === undefined) throw new Error(`save: ${JSON.stringify(out.result)}`)

	return out.bytes
}

function files(bytes: Uint8Array): Record<string, Uint8Array> {
	return unzipSync(bytes)
}

function named(bytes: Uint8Array, pattern: RegExp): string[] {
	return Object.keys(files(bytes))
		.filter(name => pattern.test(name))
		.sort()
}

async function withChart(): Promise<{ readonly d: Drive; readonly slide: SlideRef; readonly id: number }> {
	const d = await driveSession(blank(), "pptx")
	const slide = d.session.deck.slides[0] as SlideRef

	expect(await d.command(insertChartOp(d.session.deck, slide, 0, "column", CELLS))).toMatchObject({ ok: true })

	return { d, slide, id: frames(d, slide, "chart")[0]?.id ?? 0 }
}

describe("presentation clipboard: objects that own parts", () => {
	it("pastes a saved chart on its slide as a chart of its own, with a workbook of its own", async () => {
		const { d, slide, id } = await withChart()

		await saved(d)

		const made = await copied(d, slide, [id])
		const chart = made.relationships.find(relationship => relationship.tree !== undefined)

		expect(chart?.tree?.map(part => part.contentType)).toContain("application/vnd.openxmlformats-officedocument.drawingml.chart+xml")
		expect(chart?.tree?.some(part => part.name.endsWith(".xlsx"))).toBe(true)
		expect(await d.command(await pasted(d, made, slide))).toMatchObject({ ok: true })

		const charts = frames(d, slide, "chart")

		expect(charts).toHaveLength(2)

		const parts = charts.map(shape => (shape.frame?.kind === "chart" ? shape.frame.part : ""))

		expect(new Set(parts).size).toBe(2)

		const bytes = await saved(d)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(named(bytes, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(2)
		expect(named(bytes, /^ppt\/embeddings\/.*\.xlsx$/u)).toHaveLength(2)

		// Each chart names a workbook of its own.
		const zip = files(bytes)
		const workbooks = named(bytes, /^ppt\/charts\/_rels\/chart\d+\.xml\.rels$/u).map(
			name => /Target="([^"]+\.xlsx)"/u.exec(strFromU8(zip[name] as Uint8Array))?.[1]
		)

		expect(new Set(workbooks).size).toBe(2)

		const back = await openDeck(bytes)
		const read = await back.parts.slide(back.deck.slides[0] as SlideRef)

		expect(read.shapes.filter(shape => shape.frame?.kind === "chart")).toHaveLength(2)
	})

	it("pastes a chart no save stored yet, and a chart into another deck", async () => {
		const { d, slide, id } = await withChart()
		const second = d.session.deck.slides[1] as SlideRef
		const made = await copied(d, slide, [id])

		expect(await d.command(await pasted(d, made, second))).toMatchObject({ ok: true })
		expect(frames(d, second, "chart")).toHaveLength(1)

		const other = await driveSession(blank("other"), "pptx")
		const target = other.session.deck.slides[0] as SlideRef

		expect(await other.command(await pasted(other, made, target, d))).toMatchObject({ ok: true })

		// The pasted chart draws before any save.
		const rendered = await viewCapability.render(other.context, [target])

		expect(rendered).toBeDefined()

		const [own, theirs] = [await saved(d), await saved(other)] as const

		for (const bytes of [own, theirs]) expect(await danglingReferences(bytes)).toEqual([])

		expect(named(own, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(2)
		expect(named(own, /^ppt\/embeddings\/.*\.xlsx$/u)).toHaveLength(2)
		expect(named(theirs, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(1)
		expect(named(theirs, /^ppt\/embeddings\/.*\.xlsx$/u)).toHaveLength(1)
	})

	it("undoes and redoes a pasted chart across saves without parts or relationships left behind", async () => {
		const { d, slide, id } = await withChart()

		await saved(d)

		const made = await copied(d, slide, [id])

		expect(await d.command(await pasted(d, made, slide))).toMatchObject({ ok: true })

		const first = await saved(d)

		expect(named(first, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(2)
		expect(await d.undo()).toMatchObject({ ok: true })

		const undone = await saved(d)

		expect(await danglingReferences(undone)).toEqual([])
		expect(await d.redo()).toMatchObject({ ok: true })

		const redone = await saved(d)

		expect(await danglingReferences(redone)).toEqual([])
		expect(frames(d, slide, "chart")).toHaveLength(2)
		expect(named(redone, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(2)
	})

	it("pastes a diagram, an embedded object and ink within the deck and into another, each with parts of its own", async () => {
		const d = await driveSession(objectsDeck(), "pptx")
		const [first, second] = d.session.deck.slides as [SlideRef, SlideRef]

		await viewCapability.render(d.context, [first, second])

		const made = await copied(d, first, [4, 7, 8, 9])
		const trees = made.relationships.filter(relationship => relationship.tree !== undefined)

		// Data (with its picture), layout, style, colours, the drawing its data names, the object and both inks.
		expect(trees).toHaveLength(8)
		expect(made.relationships.find(relationship => relationship.id === "rId15")?.with).toBe("rId11")
		expect(await d.command(await pasted(d, made, second))).toMatchObject({ ok: true })
		expect(nodeOf(d, second).shapes.map(shape => shape.name)).toEqual(["TextBox 1", "Diagram 3", "Object 6", "Ink 7", "Ink 8"])

		const other = await driveSession(blank("other"), "pptx")
		const target = other.session.deck.slides[0] as SlideRef

		await viewCapability.render(other.context, [target])
		expect(await other.command(await pasted(other, made, target, d))).toMatchObject({ ok: true })
		expect(await viewCapability.render(other.context, [target])).toBeDefined()

		const own = await saved(d)
		const theirs = await saved(other)

		for (const bytes of [own, theirs]) expect(await danglingReferences(bytes)).toEqual([])

		expect(named(own, /^ppt\/diagrams\/data\d+\.xml$/u)).toHaveLength(2)
		expect(named(own, /^ppt\/diagrams\/drawing\d+\.xml$/u)).toHaveLength(2)
		expect(named(own, /^ppt\/embeddings\/oleObject\d+\.bin$/u)).toHaveLength(2)
		expect(named(own, /^ppt\/ink\/ink\d+\.xml$/u)).toHaveLength(4)
		expect(named(theirs, /^ppt\/diagrams\/(data|layout|quickStyle|colors|drawing)\d+\.xml$/u)).toHaveLength(5)
		expect(named(theirs, /^ppt\/embeddings\/oleObject\d+\.bin$/u)).toHaveLength(1)
		expect(named(theirs, /^ppt\/ink\/ink\d+\.xml$/u)).toHaveLength(2)

		// The copied data names the drawing the pasted slide relates, and its picture.
		const zip = files(theirs)
		const slideRels = strFromU8(zip["ppt/slides/_rels/slide1.xml.rels"] as Uint8Array)
		const dataName = /Target="\.\.\/diagrams\/(data\d+\.xml)"/u.exec(slideRels)?.[1] ?? ""
		const relId = /relId="([^"]+)"/u.exec(strFromU8(zip[`ppt/diagrams/${dataName}`] as Uint8Array))?.[1] ?? ""

		expect(slideRels).toMatch(new RegExp(`Id="${relId}"[^>]*diagramDrawing"`, "u"))
		expect(strFromU8(zip[`ppt/diagrams/_rels/${dataName}.rels`] as Uint8Array)).toContain("../media/")

		const back = await openDeck(theirs)
		const read = await back.parts.slide(back.deck.slides[0] as SlideRef)

		expect(read.shapes.map(shape => shape.name)).toEqual(["TextBox 1", "Diagram 3", "Object 6", "Ink 7", "Ink 8"])
	})

	it("copies a diagram as an edit left it, its data naming no stale drawing", async () => {
		const d = await driveSession(objectsDeck(), "pptx")
		const [first, second] = d.session.deck.slides as [SlideRef, SlideRef]

		await viewCapability.render(d.context, [first, second])
		await smartartCapability.info(d.session, { slide: first, id: 4 })

		const frame = nodeOf(d, first).shapes.find(shape => shape.id === 4)?.frame
		const data = frame?.kind === "smartart" ? frame.data : ""
		const parts = (await import("../dom/presentation/engine/open/pptx")).pptxParts(d.session.deck)
		const document = parts?.document(data)
		const one =
			/modelId="([^"]+)"[^>]*>(?:(?!<\/dgm:pt>).)*<a:t>One<\/a:t>/su.exec(new TextDecoder().decode(document?.bytes))?.[1] ?? ""

		expect(
			await d.command({ family: "smartart", kind: "setNodeText", target: { slide: first, id: 4 }, node: one, text: "Uno" })
		).toMatchObject({ ok: true })

		const made = await copied(d, first, [4])
		const copiedData = made.relationships.find(relationship => relationship.tree?.[0]?.contentType.endsWith("diagramData+xml"))

		expect(new TextDecoder().decode(copiedData?.bytes)).toContain("Uno")
		expect(new TextDecoder().decode(copiedData?.bytes)).not.toContain("relId=")
		expect(made.relationships.some(relationship => relationship.with !== undefined)).toBe(false)
		expect(await d.command(await pasted(d, made, second))).toMatchObject({ ok: true })

		const bytes = await saved(d)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(named(bytes, /^ppt\/diagrams\/data\d+\.xml$/u).length).toBeGreaterThanOrEqual(2)
	})

	it("copies two charts no save stored yet together, each with its own workbook", async () => {
		const { d, slide, id } = await withChart()

		expect(await d.command(insertChartOp(d.session.deck, slide, 0, "column", CELLS))).toMatchObject({ ok: true })

		const ids = frames(d, slide, "chart").map(shape => shape.id)

		expect(ids).toContain(id)

		const made = await copied(d, slide, ids)
		const roots = made.relationships.filter(relationship => relationship.tree !== undefined).map(relationship => relationship.target)

		expect(new Set(roots).size).toBe(2)

		const other = await driveSession(blank("other"), "pptx")
		const target = other.session.deck.slides[0] as SlideRef

		expect(await other.command(await pasted(other, made, target, d))).toMatchObject({ ok: true })

		const bytes = await saved(other)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(named(bytes, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(2)
		expect(named(bytes, /^ppt\/embeddings\/.*\.xlsx$/u)).toHaveLength(2)
	})

	it("edits a pasted chart before any save, and saves it whole", async () => {
		const { d, slide, id } = await withChart()

		await saved(d)

		const made = await copied(d, slide, [id])
		const other = await driveSession(blank("other"), "pptx")
		const target = other.session.deck.slides[0] as SlideRef

		expect(await other.command(await pasted(other, made, target, d))).toMatchObject({ ok: true })

		const chart = frames(other, target, "chart")[0]?.id ?? 0

		expect(
			await other.command({
				family: "chart",
				kind: "edit",
				target: { slide: target, id: chart },
				edit: { kind: "title", text: "Edited" }
			})
		).toMatchObject({ ok: true })

		const bytes = await saved(other)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(
			named(bytes, /^ppt\/charts\/chart\d+\.xml$/u).some(name => strFromU8(files(bytes)[name] as Uint8Array).includes("Edited"))
		).toBe(true)
		expect(named(bytes, /^ppt\/embeddings\/.*\.xlsx$/u).length).toBeGreaterThan(0)
	})

	it("edits a pasted diagram before any save, and saves it whole", async () => {
		const d = await driveSession(objectsDeck(), "pptx")
		const [first, second] = d.session.deck.slides as [SlideRef, SlideRef]

		await viewCapability.render(d.context, [first, second])

		const made = await copied(d, first, [4])

		expect(await d.command(await pasted(d, made, second))).toMatchObject({ ok: true })

		const id = nodeOf(d, second).shapes.find(shape => shape.name === "Diagram 3")?.id ?? 0
		const info = await smartartCapability.info(d.session, { slide: second, id })
		const node = info.nodes.find(each => each.text === "One")?.id ?? ""

		expect(node).not.toBe("")
		expect(
			await d.command({ family: "smartart", kind: "setNodeText", target: { slide: second, id }, node, text: "Uno" })
		).toMatchObject({
			ok: true
		})

		const bytes = await saved(d)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(
			named(bytes, /^ppt\/diagrams\/data\d+\.xml$/u).some(name => strFromU8(files(bytes)[name] as Uint8Array).includes("Uno"))
		).toBe(true)
	})

	it("reads a pasted chart's data from the parts the paste carried, before any save", async () => {
		const { d, slide, id } = await withChart()
		const made = await copied(d, slide, [id])
		const other = await driveSession(blank("other"), "pptx")
		const target = other.session.deck.slides[0] as SlideRef

		expect(await other.command(await pasted(other, made, target, d))).toMatchObject({ ok: true })

		const pasteId = frames(other, target, "chart")[0]?.id ?? 0
		const data = await chartData(other.context, { slide: target, id: pasteId })

		expect(data).toBeDefined()
	})
})

// A deck whose layouts differ from the fixture's: "Title Only" first, then "Title and Content" with its content
// placeholder at idx 7.
function destination(notes: boolean): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Destination"))),
				layout: 2,
				...(notes ? { notes: para("Existing notes") } : {})
			}
		],
		layouts: [
			{ name: "Title Only", type: "titleOnly", shapes: sp(2, "Title 1", 'type="title"') },
			{
				name: "Title and Content",
				type: "obj",
				shapes: sp(2, "Title 1", 'type="title"') + sp(3, "Content Placeholder 2", 'idx="7"', xfrm(150, 750, 2900, 1900))
			}
		]
	})
}

function source(): Uint8Array {
	const jump = sp(
		6,
		"Jump",
		undefined,
		xfrm(0, 0, 100, 100),
		body('<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId9" action="ppaction://hlinksldjump"/></a:rPr><a:t>Go</a:t></a:r></a:p>')
	)

	return buildPptx({
		slides: [
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("First"))) },
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Pasted"))) +
					sp(3, "Content Placeholder 2", 'idx="1"', "", body(para("Point"))) +
					pic(4, "Picture 3", "rId5", xfrm(10000, 10000, 100000, 100000)) +
					jump,
				rels: [
					["rId5", "image", "../media/image1.png"],
					["rId9", "slide", "slide1.xml"]
				],
				notes: para("Speaker notes")
			}
		],
		defaults: '<Default Extension="png" ContentType="image/png"/>',
		parts: { "ppt/media/image1.png": { data: PNG } }
	})
}

async function exported(d: Drive, slides: readonly SlideRef[]): Promise<readonly ImportedSlide[]> {
	const result = await clipSlides(d.context, slides)

	if (!result.ok) throw new Error(`clipSlides: ${result.refusal}`)

	return result.slides
}

describe("presentation clipboard: slides into another deck", () => {
	it("pastes slides with the destination's theme: its matching layout and placeholders, its pictures and chart, its jumps made next-slide ones", async () => {
		const from = await driveSession(source(), "pptx")
		const to = await driveSession(destination(true), "pptx")
		const [, second] = from.session.deck.slides as [SlideRef, SlideRef]

		await viewCapability.render(from.context, [second])

		// A chart no save stored yet comes with the slide.
		expect(await from.command(insertChartOp(from.session.deck, second, 0, "column", CELLS))).toMatchObject({ ok: true })

		const slides = await exported(from, [second])
		const op = importSlidesOp(slides, to.session.deck.slides, 0)

		if (typeof op === "string") throw new Error(op)

		expect(await to.command(op)).toMatchObject({ ok: true })

		const pasted = to.session.deck.slides[1] as SlideRef
		const node = nodeOf(to, pasted)
		const layout = to.session.deck.nodes.get(node.parent as SlideRef)

		expect(to.session.deck.slides).toHaveLength(2)
		expect(layout?.name).toBe("Title and Content")
		expect(node.shapes.find(shape => shape.name === "Content Placeholder 2")?.ph?.idx).toBe(7)
		expect(node.notes).toBeDefined()
		expect(await viewCapability.render(to.context, [pasted])).toBeDefined()

		const bytes = await saved(to)
		const zip = files(bytes)
		const slidePart =
			Object.keys(zip).find(
				name => /^ppt\/slides\/slide\d+\.xml$/u.test(name) && strFromU8(zip[name] as Uint8Array).includes("Pasted")
			) ?? ""
		const markup = strFromU8(zip[slidePart] as Uint8Array)
		const rels = strFromU8(zip[slidePart.replace("slides/", "slides/_rels/") + ".rels"] as Uint8Array)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(rels).toContain("../slideLayouts/slideLayout2.xml")
		expect(rels).toMatch(/relationships\/image"/u)
		expect(rels).toMatch(/relationships\/chart"/u)
		expect(rels).not.toMatch(/relationships\/slide"/u)
		expect(markup).toContain('idx="7"')
		expect(markup).toContain("ppaction://hlinkshowjump?jump=nextslide")
		expect(named(bytes, /^ppt\/notesSlides\/notesSlide\d+\.xml$/u)).toHaveLength(2)
		expect(named(bytes, /^ppt\/notesMasters\/notesMaster\d+\.xml$/u)).toHaveLength(1)
		expect(named(bytes, /^ppt\/embeddings\/.*\.xlsx$/u)).toHaveLength(1)

		const back = await openDeck(bytes)

		expect(back.deck.slides).toHaveLength(2)

		// Undone and saved: nothing of it stays.
		expect(await to.undo()).toMatchObject({ ok: true })

		const undone = await saved(to)

		expect(await danglingReferences(undone)).toEqual([])
		expect(named(undone, /^ppt\/charts\/chart\d+\.xml$/u)).toHaveLength(0)
		expect(await to.redo()).toMatchObject({ ok: true })
		expect(to.session.deck.slides).toHaveLength(2)
		expect(await danglingReferences(await saved(to))).toEqual([])
	})

	it("brings a slide's notes into a deck without a notes master as notes the deck makes", async () => {
		const from = await driveSession(source(), "pptx")
		const to = await driveSession(destination(false), "pptx")
		const [, second] = from.session.deck.slides as [SlideRef, SlideRef]

		await viewCapability.render(from.context, [second])

		const op = importSlidesOp(await exported(from, [second]), to.session.deck.slides, 0)

		if (typeof op === "string") throw new Error(op)

		expect(await to.command(op)).toMatchObject({ ok: true })

		const pasted = to.session.deck.slides[1] as SlideRef
		const notes = nodeOf(to, pasted).notes

		expect(notes).toBeDefined()
		expect(JSON.stringify(to.session.deck.nodes.get(notes as SlideRef)?.shapes)).toContain("Speaker notes")

		const bytes = await saved(to)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(named(bytes, /^ppt\/notesMasters\/notesMaster\d+\.xml$/u)).toHaveLength(1)
		expect(strFromU8(files(bytes)[named(bytes, /^ppt\/notesSlides\/notesSlide\d+\.xml$/u)[0] ?? ""] as Uint8Array)).toContain(
			"Speaker notes"
		)

		expect(await to.undo()).toMatchObject({ ok: true })
		expect(to.session.deck.notesMaster).toBeUndefined()
	})

	it("cuts slides with what a paste into another deck takes", async () => {
		const from = await driveSession(source(), "pptx")
		const [, second] = from.session.deck.slides as [SlideRef, SlideRef]
		const result = await clip(from.context, { kind: "slides", slides: [second], cut: true })

		if (!result.ok || result.clip.kind !== "slides") throw new Error("clip")

		expect(result.clip.foreign).toHaveLength(1)
		expect(result.clip.foreign?.[0]?.layout).toEqual({ type: "obj", name: "Title and Content" })
	})
})

describe("a pasted slide's placeholders on another deck's layout", () => {
	const SLIDE_NS =
		'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
	const slide = (shapes: string): RawPart => ({
		name: "/ppt/slides/slide9.xml",
		contentType: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
		bytes: encodeUtf8(`<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`),
		rels: encodeUtf8(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout4.xml"/></Relationships>'
		)
	})
	const markup = (parts: readonly RawPart[] | { readonly kind: "refused" }): string =>
		"kind" in parts ? "" : new TextDecoder().decode(parts[0]?.bytes)

	it("takes the layout's indices by type, keeps the title, and sends what the layout lacks to the master", () => {
		const parts = [
			slide(
				sp(2, "Title 1", 'type="title"') +
					sp(3, "Content 2", 'idx="1"') +
					sp(4, "Content 3", 'idx="2"') +
					sp(5, "Picture 4", 'type="pic" idx="9"')
			)
		]
		const out = importedSlideParts(parts, {
			layout: "/ppt/slideLayouts/slideLayout2.xml",
			placeholders: [
				{ type: "title", idx: 0 },
				{ type: "obj", idx: 7 },
				{ type: "dt", idx: 2 }
			]
		})
		const written = markup(out)

		expect(written).toContain('<p:ph type="title"/>')
		// The first content placeholder takes the layout's content index.
		expect(written).toMatch(/name="Content 2"(?:(?!<\/p:sp>).)*idx="7"/su)
		// The second has none to take, and the layout's date has its index: an index of its own, inheriting by type.
		expect(written).toMatch(/name="Content 3"(?:(?!<\/p:sp>).)*idx="10"/su)
		// One whose index the layout does not have keeps it.
		expect(written).toMatch(/name="Picture 4"(?:(?!<\/p:sp>).)*idx="9"/su)
		expect(new TextDecoder().decode("kind" in out ? undefined : out[0]?.rels)).toContain("../slideLayouts/slideLayout2.xml")
	})
})
