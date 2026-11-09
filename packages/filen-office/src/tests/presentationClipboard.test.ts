import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { clipPartNames, pasteShapesOp, pasteSlidesOps, PASTE_STEP, type ShapeClip, type SlideClip } from "../core/presentation/edit/clip"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { clip, clipParts } from "../dom/presentation/engine/clip"
import type { ClipPart } from "../dom/presentation/protocol"
import { buildPptx, body, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences, openDeck, partsOf, saveEdits, text } from "./pptxWriteFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { image } from "./presentationObjectsFixtures"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { viewCapability } from "../dom/presentation/engine/view"

// Cut, Copy and Paste of shapes and slides through the worker: the clip a copy makes, the paste built from it, the
// relationships its markup carries to the slide it lands on, and the file a save writes from that (gate 2 proves it).

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77,
	0x53, 0xde, 0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 3, 1, 1, 0, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0,
	0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])
const PIC =
	'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="10000" y="10000"/><a:ext cx="100000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
const LINKED = sp(
	5,
	"Linked 4",
	undefined,
	`${xfrm(200000, 200000, 300000, 100000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
	body('<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId6"/></a:rPr><a:t>Filen</a:t></a:r></a:p>')
)

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("One"))) },
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Two"))) + PIC + LINKED,
				rels: [
					["rId5", "image", "../media/image1.png"],
					["rId6", "hyperlink", "https://filen.io/", "External"]
				]
			}
		],
		defaults: '<Default Extension="png" ContentType="image/png"/>',
		parts: { "ppt/media/image1.png": { data: PNG } }
	})
}

function otherDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Other"))) + PIC.replace('r:embed="rId5"', 'r:embed="rId2"'),
				rels: [["rId2", "image", "../media/image1.png"]]
			}
		],
		defaults: '<Default Extension="png" ContentType="image/png"/>',
		// Another picture under the same name: a pasted one must never be shown as it.
		parts: { "ppt/media/image1.png": { data: PNG.slice().reverse() } }
	})
}

const EDIT = { emit: emitPptx } as never

async function shapes(h: EditHarness, slide: SlideRef, ids: readonly number[]): Promise<ShapeClip> {
	const result = await clip(h.context, { kind: "shapes", slide, shapes: ids })

	if (!result.ok || result.clip.kind !== "shapes") throw new Error(`clip: ${JSON.stringify(result)}`)

	return result.clip
}

function boxesOf(node: SlideNode | undefined): Xfrm[] {
	return (node?.shapes ?? []).flatMap(shape => (shape.xfrm === undefined ? [] : [shape.xfrm]))
}

function pasteOp(h: EditHarness, made: ShapeClip, slide: SlideRef, parts?: readonly ClipPart[]): DeckOp {
	const op = pasteShapesOp(made, {
		slide,
		boxes: boxesOf(h.session.deck.nodes.get(slide)),
		sameDeck: parts === undefined,
		format: "pptx",
		...(parts === undefined ? {} : { parts: new Map(parts.map(part => [part.name, part] as const)) })
	})

	if (typeof op === "string") throw new Error(`paste: ${op}`)

	return op
}

function named(node: SlideNode | undefined, name: string): ShapeNode[] {
	return (node?.shapes ?? []).filter(shape => shape.name === name)
}

function relsOf(parts: Map<string, Uint8Array>, part: string): string {
	return text(parts.get(part.slice(1).replace("slides/", "slides/_rels/") + ".rels"))
}

describe("presentation clipboard", () => {
	it("pastes a copied picture on its own slide one step down and right, as one undo step", async () => {
		const h = await editHarness(deck(), EDIT)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [4])

		expect(made.shapes).toHaveLength(1)
		expect(made.relationships.map(relationship => relationship.id)).toEqual(["rId5"])
		expect(await h.command(pasteOp(h, made, second.ref))).toMatchObject({ ok: true })

		const pictures = named(h.session.deck.nodes.get(second.ref), "Picture 3")

		expect(pictures).toHaveLength(2)
		expect(pictures[1]?.xfrm).toMatchObject({ x: 10000 + PASTE_STEP, y: 10000 + PASTE_STEP })
		// A second paste cascades.
		expect(await h.command(pasteOp(h, made, second.ref))).toMatchObject({ ok: true })
		expect(named(h.session.deck.nodes.get(second.ref), "Picture 3")[2]?.xfrm).toMatchObject({ x: 10000 + 2 * PASTE_STEP })

		const bytes = await saveEdits(h, 2)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(await h.undo()).toMatchObject({ ok: true })
		expect(named(h.session.deck.nodes.get(second.ref), "Picture 3")).toHaveLength(2)
	})

	it("pastes onto another slide where the shapes were, carrying the picture and the link they name", async () => {
		const h = await editHarness(deck(), EDIT)
		const first = await h.slide(0)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [4, 5])

		expect(new Set(made.relationships.map(relationship => relationship.id))).toEqual(new Set(["rId5", "rId6"]))
		expect(await h.command(pasteOp(h, made, first.ref))).toMatchObject({ ok: true })

		const node = h.session.deck.nodes.get(first.ref)
		const picture = named(node, "Picture 3")[0]

		expect(picture?.xfrm).toMatchObject({ x: 10000, y: 10000 })
		expect(named(node, "Linked 4")[0]?.text?.paragraphs[0]?.runs[0]).toMatchObject({
			rPr: { hlinkClick: { kind: "url", href: "https://filen.io/" } }
		})

		const bytes = await saveEdits(h, 1)
		const parts = await partsOf(bytes)
		const rels = relsOf(parts, first.part)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(rels).toContain("../media/image1.png")
		expect(rels).toContain("https://filen.io/")
		expect(parts.get("ppt/media/image1.png")).toEqual(PNG)

		const back = await openDeck(bytes)
		const read = await back.parts.slide(back.deck.slides[0] as SlideRef)

		expect(read.shapes.map(shape => shape.name)).toEqual(["Title 1", "Picture 3", "Linked 4"])
	})

	it("cuts as a delete of its own and pastes the cut shapes back where they were", async () => {
		const h = await editHarness(deck(), EDIT)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [4])

		expect(await h.command({ family: "shape", kind: "delete", slide: second.ref, shapes: [4] })).toMatchObject({ ok: true })
		expect(await h.command(pasteOp(h, made, second.ref))).toMatchObject({ ok: true })

		const pictures = named(h.session.deck.nodes.get(second.ref), "Picture 3")

		expect(pictures).toHaveLength(1)
		expect(pictures[0]?.xfrm).toMatchObject({ x: 10000, y: 10000 })
		expect(await danglingReferences(await saveEdits(h, 2))).toEqual([])
	})

	it("redoes a paste with the ids and relationships it took", async () => {
		const h = await editHarness(deck(), EDIT)
		const first = await h.slide(0)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [4])

		expect(await h.command(pasteOp(h, made, first.ref))).toMatchObject({ ok: true })

		const id = named(h.session.deck.nodes.get(first.ref), "Picture 3")[0]?.id

		expect(await h.undo()).toMatchObject({ ok: true })
		expect(named(h.session.deck.nodes.get(first.ref), "Picture 3")).toHaveLength(0)
		expect(await h.redo()).toMatchObject({ ok: true })
		expect(named(h.session.deck.nodes.get(first.ref), "Picture 3")[0]?.id).toBe(id)
		expect(await danglingReferences(await saveEdits(h, 3))).toEqual([])
	})

	it("pastes into another deck with the picture's bytes, under a name of that deck's own", async () => {
		const source = await editHarness(deck(), EDIT)
		const target = await editHarness(otherDeck(), EDIT)
		const second = await source.slide(1)
		const slide = await target.slide(0)
		const made = await shapes(source, second.ref, [4])
		const parts = await clipParts(source.context, clipPartNames(made))

		if (!parts.ok) throw new Error("parts")

		expect(pasteShapesOp(made, { slide: slide.ref, boxes: [], sameDeck: false, format: "pptx" })).toBe("notFound")
		expect(await target.command(pasteOp(target, made, slide.ref, parts.parts))).toMatchObject({ ok: true })

		const bytes = await saveEdits(target, 1)
		const written = await partsOf(bytes)
		const rels = relsOf(written, slide.part)
		const media = [...written.keys()].filter(name => name.startsWith("ppt/media/"))

		expect(await danglingReferences(bytes)).toEqual([])
		expect(media).toHaveLength(2)
		expect(written.get("ppt/media/image1.png")).toEqual(PNG.slice().reverse())
		expect(written.get(media.find(name => name !== "ppt/media/image1.png") ?? "")).toEqual(PNG)
		expect(rels.match(/relationships\/image"/gu)?.length).toBe(2)
	})

	it("refuses a clip of another deck that links to one of its slides", async () => {
		const source = await editHarness(
			buildPptx({
				slides: [
					{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("One"))) },
					{
						shapes: sp(
							3,
							"Jump",
							undefined,
							xfrm(0, 0, 100, 100),
							body(
								'<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId9" action="ppaction://hlinksldjump"/></a:rPr><a:t>Go</a:t></a:r></a:p>'
							)
						),
						rels: [["rId9", "slide", "slide1.xml"]]
					}
				]
			}),
			EDIT
		)
		const second = await source.slide(1)
		const made = await shapes(source, second.ref, [3])

		expect(made.relationships[0]?.jump).toBe(true)
		expect(pasteShapesOp(made, { slide: second.ref, boxes: [], sameDeck: false, format: "pptx", parts: new Map() })).toBe("unsupported")
		// Within its deck the link is carried.
		const first = await source.slide(0)

		expect(await source.command(pasteOp(source, made, first.ref))).toMatchObject({ ok: true })
		expect(await danglingReferences(await saveEdits(source, 1))).toEqual([])
	})

	it("pastes onto a slide made since the last save, and copies a shape with the edits made to it", async () => {
		const h = await editHarness(deck(), EDIT)
		const second = await h.slide(1)
		const layout = second.parent as SlideRef

		expect(
			await h.command({
				family: "shape",
				kind: "setProps",
				target: { slide: second.ref, id: 4 },
				props: { ln: { w: 25400, fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } } } }
			})
		).toMatchObject({ ok: true })
		expect(await h.command({ family: "slide", kind: "add", at: 2, layout })).toMatchObject({ ok: true })

		const added = h.session.deck.slides[2] as SlideRef
		const made = await shapes(h, second.ref, [4])

		expect(await h.command(pasteOp(h, made, added))).toMatchObject({ ok: true })
		expect(named(h.session.deck.nodes.get(added), "Picture 3")[0]?.props?.ln).toBeUndefined()

		const bytes = await saveEdits(h, 3)
		const parts = await partsOf(bytes)
		const part = h.session.deck.nodes.get(added)?.part ?? ""

		expect(await danglingReferences(bytes)).toEqual([])
		expect(relsOf(parts, part)).toContain("../media/image1.png")
		expect(text(parts.get(part.slice(1)))).toContain('val="00FF00"')
	})

	it("copies a picture an edit inserted before any save stored it, with its bytes", async () => {
		const h = await editHarness(deck(), EDIT)
		const first = await h.slide(0)
		const second = await h.slide(1)
		const picture: ShapeNode = {
			id: 0,
			name: "Inserted",
			hidden: false,
			kind: "pic",
			xfrm: { x: 500, y: 600, cx: 2000, cy: 1000, rot: 0, flipH: false, flipV: false }
		}

		expect(await h.command({ family: "picture", kind: "insert", slide: second.ref, shape: picture, image: image() })).toMatchObject({
			ok: true
		})

		const id = named(h.session.deck.nodes.get(second.ref), "Inserted")[0]?.id ?? 0
		const made = await shapes(h, second.ref, [id])

		expect(made.relationships[0]?.bytes).toBeDefined()
		expect(clipPartNames(made)).toEqual([])
		expect(await h.command(pasteOp(h, made, first.ref))).toMatchObject({ ok: true })

		const bytes = await saveEdits(h, 2)
		const parts = await partsOf(bytes)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(relsOf(parts, first.part)).toMatch(/relationships\/image"/u)
	})

	it("duplicates a slide holding a paste no save wrote yet, its copy relating what the paste carried", async () => {
		const h = await editHarness(deck(), EDIT)
		const first = await h.slide(0)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [4, 5])

		expect(await h.command(pasteOp(h, made, first.ref))).toMatchObject({ ok: true })
		expect(await h.command({ family: "slide", kind: "duplicate", slide: first.ref })).toMatchObject({ ok: true })

		const copy = h.session.deck.nodes.get(h.session.deck.slides[1] as SlideRef)
		const bytes = await saveEdits(h, 2)
		const parts = await partsOf(bytes)

		expect(await danglingReferences(bytes)).toEqual([])
		expect(relsOf(parts, copy?.part ?? "")).toContain("../media/image1.png")
		expect(relsOf(parts, copy?.part ?? "")).toContain("https://filen.io/")
	})

	it("pastes a copied placeholder as a placeholder of the slide it lands on", async () => {
		const h = await editHarness(deck(), EDIT)
		const first = await h.slide(0)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [2])

		expect(await h.command(pasteOp(h, made, first.ref))).toMatchObject({ ok: true })

		const titles = named(h.session.deck.nodes.get(first.ref), "Title 1")

		expect(titles.map(title => title.ph?.type)).toEqual(["title", "title"])
		expect(titles[1]?.text?.paragraphs[0]?.runs[0]).toMatchObject({ text: "Two" })
		expect(await danglingReferences(await saveEdits(h, 1))).toEqual([])
	})

	it("copies shapes' text for other apps", async () => {
		const h = await editHarness(deck(), EDIT)
		const second = await h.slide(1)
		const made = await shapes(h, second.ref, [2, 5])

		expect(made.text).toEqual([["Two"], ["Filen"]])
	})

	it("pastes an ODP shape onto another page of its deck, and never into another deck", async () => {
		const box =
			'<draw:custom-shape draw:name="Box" svg:x="2cm" svg:y="3cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/><text:p>Boxed</text:p></draw:custom-shape>'
		const d = await driveSession(
			odpBytes({
				body: `<draw:page draw:name="One" draw:master-page-name="M">${box}</draw:page><draw:page draw:name="Two" draw:master-page-name="M"></draw:page>`
			}),
			"odp"
		)
		const [one, two] = d.session.deck.slides as [SlideRef, SlideRef]

		await viewCapability.render(d.context, [one, two])

		const id = named(d.session.deck.nodes.get(one), "Box")[0]?.id ?? 0
		const result = await clip(d.context, { kind: "shapes", slide: one, shapes: [id] })

		if (!result.ok || result.clip.kind !== "shapes") throw new Error("clip")

		const made = result.clip

		expect(made.text).toEqual([["Boxed"]])
		expect(pasteShapesOp(made, { slide: two, boxes: [], sameDeck: false, format: "odp" })).toBe("unsupported")

		const op = pasteShapesOp(made, { slide: two, boxes: [], sameDeck: true, format: "odp" })

		if (typeof op === "string") throw new Error(op)

		expect((await d.command(op)).ok).toBe(true)

		const outcome = await d.save()

		if (outcome.result.kind !== "written" || outcome.bytes === undefined) throw new Error(JSON.stringify(outcome.result))

		const content = strFromU8(unzipSync(outcome.bytes)["content.xml"] as Uint8Array)
		const pages = content.split("<draw:page ").slice(1)

		expect(pages).toHaveLength(2)
		expect(pages[1]).toContain('draw:name="Box"')
		expect(pages[1]).toContain("Boxed")
	})

	it("pastes copied slides after the current one, and a cut's slides back from what the cut held", async () => {
		const h = await editHarness(deck(), EDIT)
		const order = (): SlideRef[] => [...h.session.deck.slides]
		const [first, second] = order() as [SlideRef, SlideRef]
		const copied = await clip(h.context, { kind: "slides", slides: [second] })

		if (!copied.ok || copied.clip.kind !== "slides") throw new Error("clip")

		for (const op of pasteSlidesOps(copied.clip, order(), 0, true) as DeckOp[]) expect(await h.command(op)).toMatchObject({ ok: true })

		expect(order()).toHaveLength(3)
		expect(order()[2]).toBe(second)

		const cut = await clip(h.context, { kind: "slides", slides: [second], cut: true })

		if (!cut.ok || cut.clip.kind !== "slides") throw new Error("clip")

		const held: SlideClip = cut.clip

		expect(held.held).toHaveLength(1)
		expect(await h.command({ family: "slide", kind: "delete", slides: [second] })).toMatchObject({ ok: true })
		expect(order()).not.toContain(second)

		for (const op of pasteSlidesOps(held, order(), -1, true) as DeckOp[]) expect(await h.command(op)).toMatchObject({ ok: true })

		expect(order()[0]).toBe(second)
		expect(order()).toContain(first)
		// Pasted again: a copy of it.
		for (const op of pasteSlidesOps(held, order(), 0, true) as DeckOp[]) expect(await h.command(op)).toMatchObject({ ok: true })

		expect(order()).toHaveLength(4)
		expect(await danglingReferences(await saveEdits(h, 5))).toEqual([])
	})
})
