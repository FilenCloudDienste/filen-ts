import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { slideRef, type Deck, type ShapeNode, type SlideNode, type SlideRef } from "../core/presentation/model"
import { spliceSnapshot, type PptxSpliceSource } from "../core/pptx/write/splice"
import { savePptx, writeSnapshot } from "../core/pptx/write/save"
import { parseXml } from "../core/xml/index"
import { NS, body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { Changes, openDeck, partsOf, save, shapeOf, slideNode, text, type OpenedDeck } from "./pptxWriteFixtures"

const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const SECTIONS =
	`<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="${P14}">` +
	'<p14:section name="Intro" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section>' +
	'<p14:section name="Rest" id="{22222222-2222-2222-2222-222222222222}"><p14:sldIdLst><p14:sldId id="258"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>'
const SHOWS =
	'<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId102"/><p:sld r:id="rId103"/></p:sldLst></p:custShow></p:custShowLst>'

function deckBytes(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Hello"))) +
					sp(
						5,
						"Box",
						undefined,
						`${xfrm(100, 200, 300, 400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`,
						body(para("Box text") + para("Second"))
					),
				notes: "Speaker notes one"
			},
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Jump"))) +
					'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Link"><a:hlinkClick r:id="rId7" action="ppaction://hlinksldjump"/></p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>',
				rels: [["rId7", "slide", "slide3.xml"]]
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Third"))) }
		],
		presentation: `${SHOWS}${SECTIONS}`
	})
}

async function opened(): Promise<OpenedDeck> {
	return openDeck(deckBytes())
}

function part(node: SlideNode): string {
	return node.part
}

describe("pptx splice writer", () => {
	it("saves an untouched deck as unchanged, and writes it back byte for byte when forced", async () => {
		const deck = await opened()
		const unchanged = await save(deck, new Changes().build())

		expect(unchanged.outcome).toEqual({ kind: "unchanged" })

		// Every slide and shape marked dirty with nothing changed in the model: every part reads back as it was.
		const changes = new Changes()

		for (const ref of deck.deck.slides) {
			const node = deck.deck.nodes.get(ref) as SlideNode

			changes.slide(node.part, { kind: "node" })
			for (const shape of node.shapes) changes.shape(node.part, shape.id, { kind: "node" })
		}

		const snapshot = await spliceSnapshot({ deck: deck.deck, source: deck.source, changes: changes.build(), revision: 3 })

		if (snapshot.kind === "refused") throw new Error(snapshot.detail)

		expect(snapshot.changes.replace).toEqual([])
		expect(snapshot.changes.add).toEqual([])

		const sink = memorySink()
		const written = await writeSnapshot(snapshot, sink)

		expect(written.kind).toBe("written")
		expect(sink.bytes()).toEqual(deck.bytes)
	})

	it("moves a shape by its xfrm attributes alone, changing only its slide part", async () => {
		const deck = await opened()
		const node = slideNode(deck, 0)
		const box = shapeOf(node, 5)

		box.xfrm = { x: 111, y: 222, cx: 333, cy: 444, rot: 5400000, flipH: true, flipV: false }

		const { outcome, bytes } = await save(deck, new Changes().shape(part(node), 5, { kind: "xfrm" }).build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const before = await partsOf(deck.bytes)
		const after = await partsOf(bytes)
		const changed = [...after].filter(([name, data]) => text(before.get(name)) !== text(data)).map(([name]) => name)

		expect(changed).toEqual(["ppt/slides/slide1.xml"])
		expect(outcome.report.entries - 1).toBe(before.size - 1)

		const slide = text(after.get("ppt/slides/slide1.xml"))

		expect(slide).toContain('<a:xfrm rot="5400000" flipH="1"><a:off x="111" y="222"/><a:ext cx="333" cy="444"/></a:xfrm>')
		// Everything else of the slide is its source.
		expect(slide.replace(/<a:xfrm[^>]*><a:off[^/]*\/><a:ext[^/]*\/><\/a:xfrm>/u, "")).toBe(
			text(before.get("ppt/slides/slide1.xml")).replace(/<a:xfrm[^>]*><a:off[^/]*\/><a:ext[^/]*\/><\/a:xfrm>/u, "")
		)

		// The second save of the saved deck, unchanged, is identical.
		const again = await openDeck(bytes)

		expect((await save(again, new Changes().build())).outcome).toEqual({ kind: "unchanged" })
	})

	it("replaces exactly the fill group of an edited shape, keeping geometry, line and text by span", async () => {
		const deck = await opened()
		const node = slideNode(deck, 0)
		const box = shapeOf(node, 5)

		box.props = { fill: { kind: "solid", color: { kind: "scheme", slot: "accent2", mods: [{ name: "lumMod", value: 75000 }] } } }

		const { outcome, bytes } = await save(deck, new Changes().shape(part(node), 5, { kind: "props", group: "fill" }).build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const slide = text((await partsOf(bytes)).get("ppt/slides/slide1.xml"))

		expect(slide).toContain(
			'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>'
		)
		expect(slide).not.toContain("FF0000")
		expect(slide).toContain("<a:t>Box text</a:t>")
	})

	it("hides a slide with its show attribute", async () => {
		const deck = await opened()
		const node = slideNode(deck, 2)

		node.hidden = true

		const { outcome, bytes } = await save(deck, new Changes().slide(part(node), { kind: "slidePart", part: "attributes" }).build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const slide = text((await partsOf(bytes)).get("ppt/slides/slide3.xml"))

		expect(slide).toMatch(/<p:sld [^>]*show="0"/u)

		const back = await openDeck(bytes)

		expect(slideNode(back, 2).hidden).toBe(true)
	})

	it("reorders slides in the slide list, keeping their ids, and keeps every slide in its section", async () => {
		const deck = await opened()
		const [a, b, c] = deck.deck.slides as [SlideRef, SlideRef, SlideRef]

		deck.deck.slides = [c, a, b]

		const { outcome, bytes } = await save(deck, new Changes().deck("slideList").build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const presentation = text((await partsOf(bytes)).get("ppt/presentation.xml"))

		expect(presentation).toContain(
			'<p:sldIdLst><p:sldId id="258" r:id="rId103"/><p:sldId id="256" r:id="rId101"/><p:sldId id="257" r:id="rId102"/></p:sldIdLst>'
		)

		const back = await openDeck(bytes)
		const sections = back.deck.sections.map(section => section.slides.map(ref => back.parts.partOf(ref)))

		// Slide 3 moved first: it belongs to "Rest" by the deck's sections, written as they are.
		expect(sections.flat().sort()).toEqual(["/ppt/slides/slide1.xml", "/ppt/slides/slide2.xml", "/ppt/slides/slide3.xml"])
	})

	it("deletes a slide that is a jump target and a section and custom show member: its notes go, the jump becomes next slide", async () => {
		const deck = await opened()
		const [a, b, c] = deck.deck.slides as [SlideRef, SlideRef, SlideRef]
		const third = slideNode(deck, 2)

		deck.deck.slides = [a, b]
		deck.deck.sections = deck.deck.sections.map(section => ({ ...section, slides: section.slides.filter(ref => ref !== c) }))
		deck.deck.customShows = deck.deck.customShows.map(show => ({ ...show, slides: show.slides.filter(ref => ref !== c) }))

		const { outcome, bytes } = await save(
			deck,
			new Changes().removed(third.part).deck("slideList").deck("sections").deck("customShows").build()
		)

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const parts = await partsOf(bytes)

		expect(parts.has("ppt/slides/slide3.xml")).toBe(false)
		expect(parts.has("ppt/slides/_rels/slide3.xml.rels")).toBe(false)
		expect(text(parts.get("[Content_Types].xml"))).not.toContain("slide3.xml")
		expect(text(parts.get("ppt/presentation.xml"))).not.toContain('id="258"')
		expect(text(parts.get("ppt/presentation.xml"))).toContain('<p:sldLst><p:sld r:id="rId102"/></p:sldLst>')

		const jumper = text(parts.get("ppt/slides/slide2.xml"))

		expect(jumper).toContain('action="ppaction://hlinkshowjump?jump=nextslide"')
		expect(text(parts.get("ppt/slides/_rels/slide2.xml.rels"))).not.toContain("slide3.xml")

		const back = await openDeck(bytes)

		expect(back.deck.slides).toHaveLength(2)
		expect(shapeOf(slideNode(back, 1), 3).actions?.click).toEqual({ kind: "internal", jump: "next" })
	})

	it("deletes a slide with notes: the notes slide goes with it, the notes master stays", async () => {
		const deck = await opened()
		const [, b, c] = deck.deck.slides as [SlideRef, SlideRef, SlideRef]

		deck.deck.slides = [b, c]
		deck.deck.sections = deck.deck.sections.map(section => ({
			...section,
			slides: section.slides.filter(ref => ref !== deck.deck.slides[0] || true)
		}))

		const { outcome, bytes } = await save(deck, new Changes().removed("/ppt/slides/slide1.xml").deck("slideList").build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const parts = await partsOf(bytes)

		expect(parts.has("ppt/notesSlides/notesSlide1.xml")).toBe(false)
		expect(parts.has("ppt/notesMasters/notesMaster1.xml")).toBe(true)
		expect(text(parts.get("[Content_Types].xml"))).not.toContain("notesSlide1.xml")
	})

	it("duplicates a slide: a new slide part, its own copy of the notes pointing back at it, the layout shared", async () => {
		const deck = await opened()
		const first = slideNode(deck, 0)
		const ref = slideRef(9000)
		const copy = duplicate(first, ref, "/ppt/slides/slide4.xml")

		deck.deck.nodes.set(ref, copy)
		deck.deck.slides.splice(1, 0, ref)

		const { outcome, bytes } = await save(deck, new Changes().slide(copy.part, { kind: "node" }, "added").deck("slideList").build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const parts = await partsOf(bytes)
		const rels = text(parts.get("ppt/slides/_rels/slide4.xml.rels"))

		expect(text(parts.get("ppt/slides/slide4.xml"))).toBe(text(parts.get("ppt/slides/slide1.xml")))
		expect(rels).toContain("../slideLayouts/slideLayout1.xml")
		expect(rels).toContain("notesSlide2.xml")
		expect(text(parts.get("ppt/notesSlides/_rels/notesSlide2.xml.rels"))).toContain("../slides/slide4.xml")
		expect(text(parts.get("[Content_Types].xml"))).toContain('PartName="/ppt/slides/slide4.xml"')
		expect(text(parts.get("ppt/presentation.xml"))).toMatch(/<p:sldId id="256" r:id="rId101"\/><p:sldId id="259" r:id="rId\d+"\/>/u)

		const back = await openDeck(bytes)

		expect(back.deck.slides).toHaveLength(4)
		expect(slideNode(back, 1).shapes.map(shape => shape.name)).toEqual(["Title 1", "Box"])
	})

	it("adds a slide written from the model: its placeholders, its layout relationship, a section", async () => {
		const deck = await opened()
		const layout = deck.deck.layouts[0] as SlideRef
		const ref = slideRef(9001)
		const added: SlideNode = {
			ref,
			kind: "slide",
			part: "/ppt/slides/slide9.xml",
			parent: layout,
			showMasterShapes: true,
			hidden: false,
			shapes: [placeholder(2, "Title 1", "title"), placeholder(3, "Content Placeholder 2", "body", 1)],
			comments: [],
			revision: 0
		}

		deck.deck.nodes.set(ref, added)
		deck.deck.slides.push(ref)

		const { outcome, bytes } = await save(deck, new Changes().slide(added.part, { kind: "node" }, "added").deck("slideList").build())

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const back = await openDeck(bytes)
		const node = slideNode(back, 3)

		expect(node.part).toBe("/ppt/slides/slide9.xml")
		expect(back.deck.nodes.get(node.parent as SlideRef)?.name).toBe("Title and Content")
		expect(node.shapes.map(shape => shape.ph?.type)).toEqual(["title", "body"])
		expect(node.shapes[0]?.text?.paragraphs[0]?.runs).toEqual([{ kind: "r", text: "New title", rPr: { lang: "en-US" } }])
		// The new slide joins the section of the slide before it.
		expect(back.deck.sections.at(-1)?.slides.map(slide => back.parts.partOf(slide))).toContain("/ppt/slides/slide9.xml")
	})

	it("writes a shape whose source is markup held after a rebase (an undone delete) from that markup", async () => {
		const deck = await opened()
		const node = slideNode(deck, 2)
		const held = parseXml(
			new TextEncoder().encode(
				`<p:sp ${NS}><p:nvSpPr><p:cNvPr id="40" name="Held"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(1, 2, 3, 4)}<a:prstGeom prst="star5"><a:avLst/></a:prstGeom><a:custDash/></p:spPr></p:sp>`
			)
		)

		node.shapes.push({
			id: 40,
			name: "Held",
			hidden: false,
			kind: "sp",
			xfrm: { x: 1, y: 2, cx: 3, cy: 4, rot: 0, flipH: false, flipV: false },
			src: { format: "pptx", part: "raw:1", node: held.documentElement(), epoch: 0 }
		})

		const sink = memorySink()
		const source: PptxSpliceSource = {
			...deck.source,
			raw: { document: name => (name === "raw:1" ? held : undefined), part: () => undefined }
		}
		const outcome = await savePptx(
			{
				deck: deck.deck,
				source,
				changes: new Changes().shape(node.part, 40, { kind: "node" }).build(),
				revision: 1
			},
			sink,
			{}
		)

		if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

		const slide = text((await partsOf(sink.bytes())).get("ppt/slides/slide3.xml"))

		// Unmodeled content (the preset, an unknown child) comes from the held markup.
		expect(slide).toContain('<a:prstGeom prst="star5"><a:avLst/></a:prstGeom><a:custDash/>')

		// Without the held markup the save is refused, never written without it.
		const refusedSave = await save(deck, new Changes().shape(node.part, 40, { kind: "node" }).build())

		expect(refusedSave.outcome).toMatchObject({ kind: "refused", reason: "stale" })
	})

	it("refuses a save whose written slide reads back differently (gate 2), on both paths", async () => {
		for (const inMemoryLimit of [Number.POSITIVE_INFINITY, 0]) {
			const deck = await opened()
			const node = slideNode(deck, 0)

			shapeOf(node, 5).xfrm = { x: 1, y: 2, cx: 3, cy: 4, rot: 0, flipH: false, flipV: false }

			const snapshot = await spliceSnapshot({
				deck: deck.deck,
				source: deck.source,
				changes: new Changes().shape(node.part, 5, { kind: "xfrm" }).build(),
				revision: 1
			})

			if (snapshot.kind === "refused") throw new Error(snapshot.detail)

			// A writer bug: the slide's bytes lose the move.
			const replace = (snapshot.changes.replace ?? []).map(change =>
				change.name === "ppt/slides/slide1.xml"
					? { ...change, bytes: new TextEncoder().encode(text(change.bytes as Uint8Array).replace('x="1"', 'x="7"')) }
					: change
			)
			const sink = memorySink()
			const outcome = await writeSnapshot({ ...snapshot, changes: { ...snapshot.changes, replace } }, sink, { inMemoryLimit })

			expect(outcome).toMatchObject({ kind: "refused", reason: "proofFailed" })
			expect(sink.bytes().length).toBe(0)
		}
	})

	it("writes a recoloured run hyperlink's colour (ahyp:hlinkClr) onto a split run, and drops it when the model does", async () => {
		const AHYP = "http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor"
		const link =
			'<a:hlinkClick r:id="rId9"><a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}">' +
			`<ahyp:hlinkClr xmlns:ahyp="${AHYP}" val="tx"/></a:ext></a:extLst></a:hlinkClick>`
		const source = buildPptx({
			slides: [
				{
					shapes: sp(4, "Link", undefined, "", body(`<a:p><a:r><a:rPr lang="en-GB">${link}</a:rPr><a:t>Link</a:t></a:r></a:p>`)),
					rels: [["rId9", "hyperlink", "https://filen.io", "External"]]
				}
			]
		})
		const runs = async (bytes: Uint8Array) =>
			(shapeOf(slideNode(await openDeck(bytes), 0), 4).text?.paragraphs[0]?.runs ?? []).map(run =>
				run.kind === "r" ? run.rPr.hlinkClick : undefined
			)
		const deck = await openDeck(source)
		const node = slideNode(deck, 0)
		const paragraph = shapeOf(node, 4).text?.paragraphs[0]
		const run = paragraph?.runs[0]

		if (paragraph === undefined || run?.kind !== "r" || run.rPr.hlinkClick === undefined) throw new Error("no linked run")

		// "Link" split into "Li" and a bold "nk": the second run has no source of its own.
		paragraph.runs = [
			{ ...run, text: "Li" },
			{ kind: "r", text: "nk", rPr: { ...run.rPr, b: true } }
		]

		const split = await save(deck, new Changes().shape(node.part, 4, { kind: "node" }).build())

		if (split.outcome.kind !== "written") throw new Error(JSON.stringify(split.outcome))

		expect(await runs(split.bytes)).toEqual([
			{ kind: "url", href: "https://filen.io", color: "tx" },
			{ kind: "url", href: "https://filen.io", color: "tx" }
		])

		// The colour taken off the source run: its extension leaves with it.
		const plain = await openDeck(source)
		const plainNode = slideNode(plain, 0)
		const plainParagraph = shapeOf(plainNode, 4).text?.paragraphs[0]
		const plainRun = plainParagraph?.runs[0]

		if (plainParagraph === undefined || plainRun?.kind !== "r") throw new Error("no linked run")

		plainParagraph.runs = [{ ...plainRun, rPr: { ...plainRun.rPr, hlinkClick: { kind: "url", href: "https://filen.io" } } }]

		const uncolored = await save(plain, new Changes().shape(plainNode.part, 4, { kind: "node" }).build())

		if (uncolored.outcome.kind !== "written") throw new Error(JSON.stringify(uncolored.outcome))

		expect(await runs(uncolored.bytes)).toEqual([{ kind: "url", href: "https://filen.io" }])
		expect(text((await partsOf(uncolored.bytes)).get("ppt/slides/slide1.xml"))).not.toContain("hlinkClr")
	})
})

function placeholder(id: number, name: string, type: "title" | "body", idx?: number): ShapeNode {
	return {
		id,
		name,
		hidden: false,
		kind: "sp",
		ph: { type, idx: idx ?? 0, ...(idx === undefined ? {} : { idxWritten: true as const }) },
		text: {
			bodyPr: {},
			paragraphs: [{ pPr: {}, runs: type === "title" ? [{ kind: "r", text: "New title", rPr: { lang: "en-US" } }] : [] }]
		}
	}
}

function duplicate(node: SlideNode, ref: SlideRef, part: string): SlideNode {
	const { notes: _notes, ...rest } = node

	return { ...rest, ref, part, shapes: node.shapes.map(shape => ({ ...shape })), comments: [], revision: 0 }
}

export type { Deck }
