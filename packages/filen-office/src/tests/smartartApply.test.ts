import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { diagramRelationshipOwner } from "../core/presentation/edit/apply/smartart"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { FrameRef, ShapeRef, SlideNode } from "../core/presentation/model"
import type { RenderServices } from "../core/presentation/render/services"
import { parseDataModel } from "../core/smartart/data"
import { diagramFindTexts, diagramOutline, newDiagramData, withDrawingReference, type DiagramOutlineNode } from "../core/smartart/edit"
import { emitDiagram } from "../core/smartart/emit"
import { layoutDiagram } from "../core/smartart/interp"
import { parseLayoutDef } from "../core/smartart/layoutDef"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { layoutEditedDiagrams, smartartCapability, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { editHarness, shapeById, type EditHarness } from "./presentationEditFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences, openDeck, partsOf, rebaseSession, saveEdits, text } from "./pptxWriteFixtures"

import { changes, odpApplier, odpDeck, openOdpDeck, saveDeck, slideAt } from "./odpWriteFixtures"
import { measurer } from "./smartartFixtures"

// SmartArt edits through the edit session: each op one undo step that puts the diagram's parts back, Find & Replace in
// one batch with the text bodies, saves that write an edited diagram into its own parts (with the drawing the
// renderer laid out) and leave nothing behind, insert from our gallery, and typed refusals.

const ASSETS = join(import.meta.dirname, "fixtures", "smartart")
const asset = (file: string): string => readFileSync(join(ASSETS, file), "utf8")
const LAYOUT = asset("test-row.xml")
const STYLE = asset("test-style-flat.xml")
const COLORS = asset("test-colors-accent.xml")
const DIAGRAM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const DRAWING_TYPE = "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"
const SLICING = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

function doc(markup: string): XmlDocument {
	return parseXml(encodeUtf8(markup))
}

// A deck whose slide holds a text box (id 2, "One fish"), a one-cell table (id 6, "One cell") and a diagram (id 4) of
// three nodes with its drawing cache.
// A 1 × 1 PNG's header (the bytes a picture part holds; nothing decodes it here).
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0
])

function diagramDeck(options: { readonly picture?: boolean } = {}): Uint8Array {
	const ids = { layout: { uniqueId: "urn:filen:smartart:layout:row", category: "list" } }
	let data = newDiagramData(["One", "Two", "Three"], ids)

	if (options.picture === true)
		data = data.replace(
			"<dgm:spPr/>",
			'<dgm:spPr><a:blipFill xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="rId1"/></a:blipFill></dgm:spPr>'
		)

	const dataWithCache = new TextDecoder().decode(withDrawingReference(doc(data), "rId15"))
	const drawing = emitDiagram(
		layoutDiagram(
			parseDataModel(doc(data)),
			parseLayoutDef(doc(LAYOUT)),
			doc(STYLE),
			doc(COLORS),
			{ x: 0, y: 0, w: 6_000_000, h: 3_000_000 },
			measurer
		)
	).drawingXml
	const frame =
		'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Diagram 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
		'<p:xfrm><a:off x="100000" y="900000"/><a:ext cx="6000000" cy="3000000"/></p:xfrm>' +
		`<a:graphic><a:graphicData uri="${DIAGRAM_URI}"><dgm:relIds xmlns:dgm="${DIAGRAM_URI}" r:dm="rId11" r:lo="rId12" r:qs="rId13" r:cs="rId14"/></a:graphicData></a:graphic></p:graphicFrame>`

	const table =
		'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table 5"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
		'<p:xfrm><a:off x="100000" y="4000000"/><a:ext cx="3000000" cy="400000"/></p:xfrm>' +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="3000000"/></a:tblGrid>' +
		'<a:tr h="400000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>One cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'

	return buildPptx({
		slides: [
			{
				shapes: `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, "TextBox 1", undefined, xfrm(100000, 100000, 3000000, 500000), body(para("One fish")))}${frame}${table}</p:spTree></p:cSld>`,
				rels: [
					["rId11", "diagramData", "../diagrams/data1.xml"],
					["rId12", "diagramLayout", "../diagrams/layout1.xml"],
					["rId13", "diagramQuickStyle", "../diagrams/quickStyle1.xml"],
					["rId14", "diagramColors", "../diagrams/colors1.xml"],
					["rId15", DRAWING_TYPE, "../diagrams/drawing1.xml"]
				]
			}
		],
		parts: {
			"ppt/diagrams/data1.xml": {
				data: dataWithCache,
				type: "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"
			},
			"ppt/diagrams/layout1.xml": { data: LAYOUT, type: "application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml" },
			"ppt/diagrams/quickStyle1.xml": {
				data: STYLE,
				type: "application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml"
			},
			"ppt/diagrams/colors1.xml": { data: COLORS, type: "application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml" },
			"ppt/diagrams/drawing1.xml": { data: drawing, type: "application/vnd.ms-office.drawingml.diagramDrawing+xml" },
			...(options.picture === true
				? {
						"ppt/diagrams/_rels/data1.xml.rels": {
							data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'
						},
						"ppt/media/image1.png": { data: PNG, type: "image/png" }
					}
				: {})
		}
	})
}

interface Diagram {
	readonly h: EditHarness
	readonly node: SlideNode
	readonly target: ShapeRef
	frame(): Extract<FrameRef, { kind: "smartart" }>
	data(): XmlDocument
	outline(): string[]
	// Lays the diagram out as the renderer does (the drawing the save writes).
	relayout(): Promise<void>
}

async function open(bytes = diagramDeck()): Promise<Diagram> {
	const h = await editHarness(bytes, {})
	const node = await h.slide(0)
	const target = { slide: node.ref, id: 4 }
	const parts = pptxParts(h.session.deck)
	const services: RenderServices = { xml: part => parts?.document(part), relationship: () => undefined, contentType: () => undefined }
	const renderer = smartArtRenderer(h.session, { services })

	// The text pane's query reads the diagram's parts, as the page asks it before any edit.
	await smartartCapability.info(h.session, target)
	const frame = (): Extract<FrameRef, { kind: "smartart" }> => {
		const value = shapeById(h.session.deck.nodes.get(node.ref)?.shapes ?? [], 4)?.frame

		if (value?.kind !== "smartart") throw new Error("no diagram")

		return value
	}
	const data = (): XmlDocument => {
		const document = parts?.document(frame().data)

		if (document === undefined) throw new Error(`data ${frame().data} not held`)

		return document
	}

	return {
		h,
		node,
		target,
		frame,
		data,
		outline: () => (diagramOutline(data()) as readonly DiagramOutlineNode[]).map(each => `${"-".repeat(each.level)}${each.text}`),
		relayout: async () => {
			await renderer.relayout(target, frame(), SLICING)
		}
	}
}

function nodeId(diagram: Diagram, text: string): string {
	const found = (diagramOutline(diagram.data()) as readonly DiagramOutlineNode[]).find(each => each.text === text)

	if (found === undefined) throw new Error(`no node ${text}`)

	return found.id
}

async function diagramParts(bytes: Uint8Array): Promise<string[]> {
	return [...(await partsOf(bytes)).keys()].filter(name => name.startsWith("ppt/diagrams/")).sort()
}

describe("SmartArt edits in the session", () => {
	it("sets a node's text as one undo step that puts the diagram's parts back", async () => {
		const diagram = await open()
		const before = diagram.frame()

		await diagram.h.command({
			family: "smartart",
			kind: "setNodeText",
			target: diagram.target,
			node: nodeId(diagram, "Two"),
			text: "Deux"
		})

		expect(diagram.outline()).toEqual(["-One", "-Deux", "-Three"])
		expect(diagram.frame().data).toMatch(/^raw:/u)
		expect(diagram.frame().layout).toBe(before.layout)

		expect((await diagram.h.undo()).ok).toBe(true)
		expect(diagram.frame()).toEqual(before)
		expect(diagram.outline()).toEqual(["-One", "-Two", "-Three"])

		expect((await diagram.h.redo()).ok).toBe(true)
		expect(diagram.outline()).toEqual(["-One", "-Deux", "-Three"])
	})

	it("adds, demotes, moves and removes nodes, each one step", async () => {
		const diagram = await open()
		const two = nodeId(diagram, "Two")

		expect(
			(
				await diagram.h.command({
					family: "smartart",
					kind: "addNode",
					target: diagram.target,
					relativeTo: two,
					position: "after",
					text: "New",
					id: "{N}"
				})
			).ok
		).toBe(true)
		expect((await diagram.h.command({ family: "smartart", kind: "demote", target: diagram.target, node: "{N}" })).ok).toBe(true)
		expect(diagram.outline()).toEqual(["-One", "-Two", "--New", "-Three"])
		expect(
			(await diagram.h.command({ family: "smartart", kind: "moveNode", target: diagram.target, node: two, direction: "up" })).ok
		).toBe(true)
		expect(diagram.outline()).toEqual(["-Two", "--New", "-One", "-Three"])
		expect((await diagram.h.command({ family: "smartart", kind: "removeNode", target: diagram.target, node: two })).ok).toBe(true)
		expect(diagram.outline()).toEqual(["-New", "-One", "-Three"])

		for (const expected of [
			["-Two", "--New", "-One", "-Three"],
			["-One", "-Two", "--New", "-Three"],
			["-One", "-Two", "-New", "-Three"],
			["-One", "-Two", "-Three"]
		]) {
			await diagram.h.undo()
			expect(diagram.outline()).toEqual(expected)
		}
	})

	it("replaces in a diagram, a text body and a table in one batch, one undo step", async () => {
		const diagram = await open()
		const before = diagram.frame()
		const batch = {
			family: "batch",
			kind: "batch",
			ops: [
				{
					family: "text",
					kind: "replace",
					query: "one",
					replacement: "1",
					targets: [{ target: { slide: diagram.node.ref, id: 2 } }, { target: { slide: diagram.node.ref, id: 6 } }]
				},
				{ family: "smartart", kind: "replace", target: diagram.target, query: "one", replacement: "1" }
			]
		} as unknown as DeckOp

		expect((await diagram.h.command(batch)).ok).toBe(true)
		expect(diagramFindTexts(diagram.data())).toEqual(["1", "Two", "Three"])

		const textBox = shapeById(diagram.h.session.deck.nodes.get(diagram.node.ref)?.shapes ?? [], 2)

		const cell = (): string => {
			const frame = shapeById(diagram.h.session.deck.nodes.get(diagram.node.ref)?.shapes ?? [], 6)?.frame

			return frame?.kind === "table"
				? (frame.table.rows[0]?.cells[0]?.text.paragraphs[0]?.runs.map(run => ("text" in run ? run.text : "")).join("") ?? "")
				: ""
		}

		expect(textBox?.text?.paragraphs[0]?.runs.map(run => ("text" in run ? run.text : "")).join("")).toBe("1 fish")
		expect(cell()).toBe("1 cell")

		await diagram.h.undo()

		expect(cell()).toBe("One cell")
		expect(diagram.frame()).toEqual(before)
		expect(diagramFindTexts(diagram.data())).toEqual(["One", "Two", "Three"])
		expect(
			shapeById(diagram.h.session.deck.nodes.get(diagram.node.ref)?.shapes ?? [], 2)
				?.text?.paragraphs[0]?.runs.map(run => ("text" in run ? run.text : ""))
				.join("")
		).toBe("One fish")
	})

	it("replaces one match a find named, refusing it stale once gone", async () => {
		const diagram = await open()
		const op = {
			family: "smartart",
			kind: "replace",
			target: diagram.target,
			query: "e",
			replacement: "E",
			caseSensitive: true,
			match: [2, 3, 4]
		} as unknown as DeckOp

		expect((await diagram.h.command(op)).ok).toBe(true)
		expect(diagramFindTexts(diagram.data())).toEqual(["One", "Two", "ThrEe"])
		expect(await diagram.h.command(op)).toMatchObject({ ok: false, refusal: "stale" })
	})

	it("switches the layout to our gallery's, and back to the file's own", async () => {
		const diagram = await open()
		const own = diagram.frame().layout

		expect(
			(
				await diagram.h.command({
					family: "smartart",
					kind: "setLayout",
					target: diagram.target,
					def: { uniqueId: "urn:filen:smartart:layout:list-vertical-bullet", source: "gallery" }
				})
			).ok
		).toBe(true)
		expect(diagram.frame().layout).toMatch(/^raw:/u)
		expect(text(diagram.data().bytes)).toContain('loTypeId="urn:filen:smartart:layout:list-vertical-bullet"')
		expect(diagram.outline()).toEqual(["-One", "-Two", "-Three"])

		expect(
			(
				await diagram.h.command({
					family: "smartart",
					kind: "setLayout",
					target: diagram.target,
					def: { uniqueId: "urn:filen:smartart:layout:row", source: "deck" }
				})
			).ok
		).toBe(true)
		expect(diagram.frame().layout).toBe(own)
		expect(
			await diagram.h.command({
				family: "smartart",
				kind: "setColors",
				target: diagram.target,
				def: { uniqueId: "urn:none", source: "deck" }
			})
		).toMatchObject({
			ok: false,
			refusal: "notFound"
		})
	})

	it("refuses typed: an unknown node, a shape that is no diagram", async () => {
		const diagram = await open()

		expect(await diagram.h.command({ family: "smartart", kind: "removeNode", target: diagram.target, node: "{nope}" })).toMatchObject({
			ok: false,
			refusal: "notFound"
		})
		expect(
			await diagram.h.command({
				family: "smartart",
				kind: "setNodeText",
				target: { slide: diagram.node.ref, id: 2 },
				node: "x",
				text: "y"
			})
		).toMatchObject({
			ok: false,
			refusal: "unsupported"
		})
	})

	it("edits a diagram whose data holds pictures: saved into its own data part, its relationships kept", async () => {
		const bytes = diagramDeck({ picture: true })
		const pictures = await open(bytes)
		const edited = await pictures.h.command({
			family: "smartart",
			kind: "setNodeText",
			target: pictures.target,
			node: nodeId(pictures, "One"),
			text: "Uno"
		})

		expect(edited.ok).toBe(true)
		// The held edit reads its pictures through the package part.
		expect(diagramRelationshipOwner(pictures.h.session.deck, pictures.frame().data)).toBe("/ppt/diagrams/data1.xml")

		await pictures.relayout()

		const saved = await partsOf(await saveEdits(pictures.h, 1))
		const data = text(saved.get("ppt/diagrams/data1.xml"))

		expect(diagramFindTexts(doc(data))).toEqual(["Uno", "Two", "Three"])
		expect(data).toContain('r:embed="rId1"')
		expect(text(saved.get("ppt/diagrams/_rels/data1.xml.rels"))).toContain('Target="../media/image1.png"')
		expect([...saved.keys()].filter(name => name.startsWith("ppt/diagrams/data"))).toEqual(["ppt/diagrams/data1.xml"])
	})

	it("writes an edit of a picture diagram whose data part another diagram shares into parts of its own", async () => {
		const pictures = await open(diagramDeck({ picture: true }))
		const node = pictures.h.session.deck.nodes.get(pictures.node.ref)
		const shape = node?.shapes.find(each => each.id === pictures.target.id)

		if (node === undefined || shape === undefined) throw new Error("no diagram")

		// A copy of the slide names the same data part until a save writes its own.
		expect(await pictures.h.command({ family: "slide", kind: "duplicate", slide: pictures.node.ref })).toMatchObject({ ok: true })

		expect(
			await pictures.h.command({
				family: "smartart",
				kind: "setNodeText",
				target: pictures.target,
				node: nodeId(pictures, "One"),
				text: "y"
			})
		).toMatchObject({ ok: true })

		await pictures.relayout()

		const bytes = await saveEdits(pictures.h, 1)
		const saved = await partsOf(bytes)
		const written = [...saved.keys()].filter(name => /^ppt\/diagrams\/data\d+\.xml$/u.test(name))
		const edited = written.find(name => diagramFindTexts(doc(text(saved.get(name))))[0] === "y") ?? ""

		expect(await danglingReferences(bytes)).toEqual([])
		// The copy keeps the text it was made with; the edit is in a part of its own that relates the picture itself.
		expect(written.map(name => diagramFindTexts(doc(text(saved.get(name)))))).toContainEqual(["One", "Two", "Three"])
		expect(diagramFindTexts(doc(text(saved.get(edited))))).toEqual(["y", "Two", "Three"])
		expect(text(saved.get(edited.replace("diagrams/", "diagrams/_rels/") + ".rels"))).toContain("../media/image1.png")
	})

	it("drops a held part once no diagram names it, holding it again under its name on undo", async () => {
		const diagram = await open()
		const parts = pptxParts(diagram.h.session.deck)

		await diagram.h.command({
			family: "smartart",
			kind: "setNodeText",
			target: diagram.target,
			node: nodeId(diagram, "One"),
			text: "A"
		})

		const first = diagram.frame()

		await diagram.h.command({ family: "smartart", kind: "setNodeText", target: diagram.target, node: nodeId(diagram, "A"), text: "B" })

		expect(parts?.document(first.data)).toBeUndefined()

		await diagram.h.undo()

		expect(diagram.frame()).toEqual(first)
		expect(diagramFindTexts(diagram.data())).toEqual(["A", "Two", "Three"])
	})

	it("answers the text pane: the outline, the definitions named and the deck's own", async () => {
		const diagram = await open()
		const info = await smartartCapability.info(diagram.h.session, diagram.target)

		expect(info.nodes.map(node => node.text)).toEqual(["One", "Two", "Three"])
		expect(info.layout).toBe("urn:filen:smartart:layout:row")
		expect(info.deckDefinitions.map(each => `${each.kind}:${each.uniqueId}`)).toEqual([
			"layout:urn:filen:smartart:layout:row",
			"style:urn:filen:smartart:style:flat",
			"colors:urn:filen:smartart:colors:accent"
		])
	})
})

describe("SmartArt saves", () => {
	it("saves an edited diagram into its own parts, twice, leaving no part behind", async () => {
		const bytes = diagramDeck()
		const diagram = await open(bytes)

		await diagram.h.command({
			family: "smartart",
			kind: "setNodeText",
			target: diagram.target,
			node: nodeId(diagram, "Two"),
			text: "Deux"
		})
		await diagram.relayout()

		const first = await saveEdits(diagram.h, 1)
		const parts = await partsOf(first)

		expect(await diagramParts(first)).toEqual(await diagramParts(bytes))
		expect(text(parts.get("ppt/diagrams/data1.xml"))).toContain("Deux")
		expect(text(parts.get("ppt/diagrams/data1.xml"))).toMatch(/<dsp:dataModelExt [^>]*relId="rId15"/u)
		expect(text(parts.get("ppt/diagrams/drawing1.xml"))).toContain("Deux")
		expect(text(parts.get("ppt/slides/slide1.xml"))).toContain('r:dm="rId11"')
		expect(await danglingReferences(first)).toEqual([])

		await rebaseSession(diagram.h, bytes, first)
		await diagram.h.command({
			family: "smartart",
			kind: "addNode",
			target: diagram.target,
			relativeTo: nodeId(diagram, "Three"),
			position: "after",
			text: "Four"
		})
		await diagram.relayout()

		const second = await saveEdits(diagram.h, 2)

		expect(await diagramParts(second)).toEqual(await diagramParts(bytes))
		expect(diagramFindTexts(doc(text((await partsOf(second)).get("ppt/diagrams/data1.xml"))))).toEqual(["One", "Deux", "Three", "Four"])
		expect(text((await partsOf(second)).get("ppt/diagrams/drawing1.xml"))).toContain("Four")

		// The saved file reads back with the diagram as edited.
		const reopened = await openDeck(second)
		const node = await reopened.parts.slide(reopened.deck.slides[0] ?? diagram.node.ref)
		const frame = shapeById(node.shapes, 4)?.frame

		expect(frame?.kind).toBe("smartart")
	})

	it("lays an edited diagram out before a save, though no slide showed it since", async () => {
		const diagram = await open()

		await diagram.h.command({
			family: "batch",
			kind: "batch",
			ops: [{ family: "smartart", kind: "replace", target: diagram.target, query: "Two", replacement: "Zwei" }]
		} as unknown as DeckOp)
		await layoutEditedDiagrams(diagram.h.session, sessionEdits(diagram.h.session).changes(), SLICING)

		const saved = await partsOf(await saveEdits(diagram.h, 1))

		expect(text(saved.get("ppt/diagrams/drawing1.xml"))).toContain("Zwei")
		expect(text(saved.get("ppt/diagrams/data1.xml"))).toMatch(/<dsp:dataModelExt [^>]*relId="rId15"/u)
	})

	it("undoes an edit after its save: the next save writes the diagram as it was", async () => {
		const bytes = diagramDeck()
		const diagram = await open(bytes)

		await diagram.h.command({
			family: "smartart",
			kind: "setNodeText",
			target: diagram.target,
			node: nodeId(diagram, "One"),
			text: "Uno"
		})
		await diagram.relayout()

		const first = await saveEdits(diagram.h, 1)

		await rebaseSession(diagram.h, bytes, first)
		await diagram.h.undo()
		await diagram.relayout()

		const second = await saveEdits(diagram.h, 2)

		expect(diagramFindTexts(doc(text((await partsOf(second)).get("ppt/diagrams/data1.xml"))))).toEqual(["One", "Two", "Three"])
		expect(await diagramParts(second)).toEqual(await diagramParts(bytes))
	})

	it("answers where an inserted diagram's empty nodes show their text prompt, as last laid out", async () => {
		const bytes = diagramDeck()
		const diagram = await open(bytes)
		const result = await diagram.h.command({
			family: "smartart",
			kind: "insert",
			slide: diagram.node.ref,
			shape: {
				id: 0,
				name: "Diagram",
				hidden: false,
				kind: "frame",
				xfrm: { x: 0, y: 4_000_000, cx: 4_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
			},
			layout: { uniqueId: "urn:filen:smartart:layout:list-vertical-bullet", source: "gallery" },
			texts: ["", "Beta", ""]
		})

		expect(result.ok).toBe(true)

		const inserted = diagram.h.session.deck.nodes.get(diagram.node.ref)?.shapes.at(-1)
		const target = { slide: diagram.node.ref, id: inserted?.id ?? 0 }
		const frame = inserted?.frame

		if (frame?.kind !== "smartart") throw new Error("not inserted")

		await smartArtRenderer(diagram.h.session, {
			services: {
				xml: part => pptxParts(diagram.h.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		}).relayout(target, frame, SLICING)

		const info = await smartartCapability.smartArtInfo(diagram.h.context, target)

		// Two empty nodes: two prompt boxes inside the frame; the node with text has none.
		expect(info.prompts).toHaveLength(2)
		expect(info.prompts?.every(box => box.w > 0 && box.h > 0 && box.x >= 0 && box.x + box.w <= 4_000_001)).toBe(true)
	})

	it("answers the empty nodes' prompts of a diagram drawn from its saved drawing, laying it out on demand", async () => {
		const bytes = diagramDeck()
		const first = await open(bytes)

		await first.h.command({ family: "smartart", kind: "setNodeText", target: first.target, node: nodeId(first, "Two"), text: "" })
		await first.relayout()

		// Reopened from the save: the frame names its drawing, nothing laid it out this session.
		const reopened = await open(await saveEdits(first.h, 1))

		expect(reopened.frame().drawing).toBeDefined()

		const info = await smartartCapability.smartArtInfo(reopened.h.context, reopened.target)

		expect(info.prompts).toHaveLength(1)
	})

	it("inserts a diagram from our gallery and saves its five parts", async () => {
		const bytes = diagramDeck()
		const diagram = await open(bytes)
		const result = await diagram.h.command({
			family: "smartart",
			kind: "insert",
			slide: diagram.node.ref,
			shape: {
				id: 0,
				name: "Diagram",
				hidden: false,
				kind: "frame",
				xfrm: { x: 0, y: 4_000_000, cx: 4_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
			},
			layout: { uniqueId: "urn:filen:smartart:layout:list-vertical-bullet", source: "gallery" },
			texts: ["Alpha", "\tBeta", "Gamma"]
		})

		expect(result.ok).toBe(true)

		const inserted = diagram.h.session.deck.nodes.get(diagram.node.ref)?.shapes.at(-1)
		const target = { slide: diagram.node.ref, id: inserted?.id ?? 0 }
		const frame = inserted?.frame

		if (frame?.kind !== "smartart") throw new Error("not inserted")

		await smartArtRenderer(diagram.h.session, {
			services: {
				xml: part => pptxParts(diagram.h.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		}).relayout(target, frame, SLICING)

		const saved = await saveEdits(diagram.h, 1)
		const before = new Set(await diagramParts(bytes))
		const added = (await diagramParts(saved)).filter(name => !before.has(name))
		const parts = await partsOf(saved)

		expect(added).toHaveLength(5)
		expect(await danglingReferences(saved)).toEqual([])
		expect(text(parts.get("[Content_Types].xml"))).toContain("diagramDrawing+xml")

		const data = added.find(name => name.includes("/data")) ?? ""

		expect(diagramFindTexts(doc(text(parts.get(data))))).toEqual(["Alpha", "Beta", "Gamma"])

		const drawing = added.find(name => name.includes("/drawing")) ?? ""

		expect(text(parts.get(drawing))).toContain("Alpha")

		await diagram.h.undo()
		expect(diagram.h.session.deck.nodes.get(diagram.node.ref)?.shapes.some(shape => shape.id === target.id)).toBe(false)
	})
})

describe("SmartArt in ODF", () => {
	it("refuses SmartArt ops in an ODF deck, typed", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = slideAt(opened, 0)
		const apply = odpApplier(opened)

		expect(
			apply({
				family: "smartart",
				kind: "insert",
				slide: slide.ref,
				shape: {
					id: 0,
					name: "Diagram",
					hidden: false,
					kind: "frame",
					xfrm: { x: 0, y: 0, cx: 1000, cy: 1000, rot: 0, flipH: false, flipV: false }
				},
				layout: { uniqueId: "urn:filen:smartart:layout:list-basic", source: "gallery" },
				texts: ["A"]
			})
		).toMatchObject({ reason: "unsupported" })
	})

	it("refuses to write a diagram not laid out instead of dropping it", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = slideAt(opened, 0)
		const apply = odpApplier(opened)

		apply({
			family: "shape",
			kind: "insert",
			slide: slide.ref,
			shape: {
				id: 0,
				name: "Diagram",
				hidden: false,
				kind: "frame",
				xfrm: { x: 0, y: 0, cx: 1000, cy: 1000, rot: 0, flipH: false, flipV: false },
				frame: { kind: "smartart", data: "d", layout: "l", style: "s", colors: "c" }
			}
		})

		expect((await saveDeck(opened, changes())).outcome).toMatchObject({ kind: "refused", reason: "unsupported" })
	})
})
