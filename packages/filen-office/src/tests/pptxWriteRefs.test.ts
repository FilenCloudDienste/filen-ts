import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { ZipChanges } from "../core/opc/index"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { emitPptx } from "../core/pptx/write/emit"
import { spliceSnapshot } from "../core/pptx/write/splice"
import { FinalPackage, verifyFinal } from "../core/pptx/write/verify"
import type { Paragraph, SlideRef, Xfrm } from "../core/presentation/model"
import { buildPptx, body, para, sp } from "./pptxFixtures"
import {
	Changes,
	changedParts,
	danglingReferences,
	openDeck,
	partsOf,
	rebaseSession,
	saveEdits,
	slideNode as slideNodeAt,
	text
} from "./pptxWriteFixtures"
import { editHarness, P14, SECTION_EXT } from "./presentationEditFixtures"

// Referential integrity of the splice writer across slide copies, removals and rebases: what a removal takes is
// judged against every part that stays (copies included), gate 2 refuses a package where a relationship or a markup
// relationship id names nothing, and a save's rebase indexes the slides the save added.

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77,
	0x53, 0xde, 0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 3, 1, 1, 0, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0,
	0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])
const PIC =
	'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="10" y="10"/><a:ext cx="1000" cy="1000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

function pictureDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("One"))) },
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Two"))) + PIC,
				rels: [["rId5", "image", "../media/image1.png"]],
				notes: para("Notes two")
			}
		],
		defaults: '<Default Extension="png" ContentType="image/png"/>',
		parts: { "ppt/media/image1.png": { data: PNG } }
	})
}

const EDIT = { emit: emitPptx } as never

describe("pptx writer referential integrity", () => {
	it("keeps a copy's picture and notes when its original is deleted in the same save", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const second = await h.slide(1)

		expect(await h.command({ family: "slide", kind: "duplicate", slide: second.ref })).toMatchObject({ ok: true })
		expect(await h.command({ family: "slide", kind: "delete", slides: [second.ref] })).toMatchObject({ ok: true })

		const bytes = await saveEdits(h, 1)
		const parts = await partsOf(bytes)
		const copy = h.session.deck.nodes.get(h.session.deck.slides[1] ?? (0 as SlideRef))

		expect(parts.has("ppt/media/image1.png")).toBe(true)
		expect(parts.has("ppt/slides/slide2.xml")).toBe(false)
		expect(await danglingReferences(bytes)).toEqual([])

		const copyPart = copy?.part.slice(1) ?? ""
		const rels = text(parts.get(copyPart.replace("slides/", "slides/_rels/") + ".rels"))

		expect(text(parts.get(copyPart))).toContain('r:embed="rId5"')
		expect(rels).toMatch(/Id="rId5"[^>]*Target="..\/media\/image1.png"/u)
		expect(rels).toContain("notesSlide")

		const back = await openDeck(bytes)

		await back.parts.parseAll()

		const notes = back.deck.nodes.get(back.deck.nodes.get(back.deck.slides[1] ?? (0 as SlideRef))?.notes ?? (0 as SlideRef))

		expect(JSON.stringify(notes?.shapes)).toContain("Notes two")
	})

	it("writes a duplicate's notes slide under the name the model gave it, with the notes' edits", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const second = await h.slide(1)

		expect(await h.command({ family: "slide", kind: "duplicate", slide: second.ref })).toMatchObject({ ok: true })

		const copyRef = h.session.deck.slides[2] ?? (0 as SlideRef)
		const copy = h.session.deck.nodes.get(copyRef)
		const notes = h.session.deck.nodes.get(copy?.notes ?? (0 as SlideRef))

		// The notes family has no ops yet: the copy's notes node edited as one would edit it.
		const paragraph = notes?.shapes.flatMap(shape => shape.text?.paragraphs ?? []).find(item => item.runs.some(run => run.kind === "r"))

		if (paragraph === undefined) throw new Error("no notes run")

		;(paragraph as { runs: Paragraph["runs"] }).runs = paragraph.runs.map(run =>
			run.kind === "r" ? { ...run, text: "Copy notes" } : run
		)

		const bytes = await saveEdits(h, 1)
		const parts = await partsOf(bytes)

		expect(notes).toBeDefined()
		expect(parts.has(notes?.part.slice(1) ?? "")).toBe(true)
		expect(text(parts.get(notes?.part.slice(1) ?? ""))).toContain("Copy notes")
		expect(text(parts.get(h.session.deck.nodes.get(second.notes ?? (0 as SlideRef))?.part.slice(1) ?? ""))).toContain("Notes two")
	})

	describe("gate 2", () => {
		async function snapshotOf(bytes: Uint8Array) {
			const opened = await openDeck(bytes)
			const node = await opened.parts.slide(opened.deck.slides[1] ?? (0 as SlideRef))
			const shape = node.shapes.find(candidate => candidate.xfrm !== undefined)

			if (shape?.xfrm === undefined) throw new Error("no shape")

			shape.xfrm = { ...shape.xfrm, x: shape.xfrm.x + 9525 }

			const snapshot = await spliceSnapshot({
				deck: opened.deck,
				source: opened.source,
				changes: new Changes().shape(node.part, shape.id, { kind: "xfrm" }).build(),
				revision: 1
			})

			if (snapshot.kind !== "snapshot") throw new Error(JSON.stringify(snapshot))

			return { opened, snapshot }
		}

		it("refuses a written part whose markup names a relationship it does not have", async () => {
			const { opened, snapshot } = await snapshotOf(pictureDeck())
			const rels = text((await partsOf(pictureDeck())).get("ppt/slides/_rels/slide2.xml.rels")).replace(
				/<Relationship Id="rId5"[^>]*\/>/u,
				""
			)
			const changes: ZipChanges = {
				...snapshot.changes,
				replace: [...(snapshot.changes.replace ?? []), { name: "ppt/slides/_rels/slide2.xml.rels", bytes: strToU8(rels) }]
			}

			expect(await verifyFinal(new FinalPackage(opened.source.package, snapshot.changes), snapshot.expectation)).toBeUndefined()
			expect(await verifyFinal(new FinalPackage(opened.source.package, changes), snapshot.expectation)).toMatchObject({
				kind: "refused",
				reason: "proofFailed",
				detail: expect.stringContaining("rId5") as unknown
			})
		})

		it("refuses a relationship of an unchanged part to a part the save removes", async () => {
			const { opened, snapshot } = await snapshotOf(pictureDeck())
			const changes: ZipChanges = { ...snapshot.changes, remove: [...(snapshot.changes.remove ?? []), "ppt/media/image1.png"] }

			expect(await verifyFinal(new FinalPackage(opened.source.package, changes), snapshot.expectation)).toMatchObject({
				kind: "refused",
				reason: "proofFailed",
				detail: expect.stringContaining("ppt/media/image1.png") as unknown
			})
		})

		it("lets through a relationship id the source part already lacked", async () => {
			const files = unzipSync(pictureDeck())

			files["ppt/slides/slide2.xml"] = strToU8(
				strFromU8(files["ppt/slides/slide2.xml"] ?? new Uint8Array()).replace('r:embed="rId5"', 'r:embed="rId9"')
			)

			const { opened, snapshot } = await snapshotOf(zipSync(files))

			expect(await verifyFinal(new FinalPackage(opened.source.package, snapshot.changes), snapshot.expectation)).toBeUndefined()
		})
	})

	it("keeps the extension lists of the slide-list entries and sections a slide delete rewrites", async () => {
		const files = unzipSync(
			buildPptx({
				slides: [0, 1, 2].map(k => ({ shapes: sp(2, "T", 'type="title"', "", body(para(`S${String(k)}`))) })),
				presentation: `<p:extLst><p:ext uri="${SECTION_EXT}"><p14:sectionLst ${P14}><p14:section name="A" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/><p14:sldId id="258"/></p14:sldIdLst><p14:extLst><p14:ext uri="{SECTION-EXT}"/></p14:extLst></p14:section></p14:sectionLst></p:ext></p:extLst>`
			})
		)

		files["ppt/presentation.xml"] = strToU8(
			strFromU8(files["ppt/presentation.xml"] ?? new Uint8Array()).replace(
				'<p:sldId id="256" r:id="rId101"/>',
				'<p:sldId id="256" r:id="rId101"><p:extLst><p:ext uri="{SLDID-EXT}"/></p:extLst></p:sldId>'
			)
		)

		const h = await editHarness(zipSync(files), EDIT)

		await h.slide(2)
		expect(await h.command({ family: "slide", kind: "delete", slides: [h.session.deck.slides[2] ?? (0 as SlideRef)] })).toMatchObject({
			ok: true
		})

		const out = text((await partsOf(await saveEdits(h, 1))).get("ppt/presentation.xml"))

		expect(out).toContain("{SLDID-EXT}")
		expect(out).toContain("{SECTION-EXT}")
		expect(out).not.toContain('<p14:sldId id="258"/>')
	})

	for (const how of ["add", "duplicate"] as const) {
		it(`indexes a slide ${how === "add" ? "added" : "duplicated"} by a save, so an edit of it after the rebase saves`, async () => {
			const h = await editHarness(pictureDeck(), EDIT)
			const deck = h.session.deck
			const second = await h.slide(1)
			const op =
				how === "add"
					? ({ family: "slide", kind: "add", at: 2, layout: deck.layouts[0] ?? (0 as SlideRef) } as const)
					: ({ family: "slide", kind: "duplicate", slide: second.ref } as const)

			expect(await h.command(op)).toMatchObject({ ok: true })

			const ref = deck.slides[2] ?? (0 as SlideRef)
			const part = deck.nodes.get(ref)?.part ?? ""
			const first = await saveEdits(h, 1)
			const parts = pptxParts(deck)

			await rebaseSession(h, pictureDeck(), first)

			const savedList = text((await partsOf(first)).get("ppt/presentation.xml"))
			const id = Number(/<p:sldId id="(\d+)"[^>]*\/>\s*<\/p:sldIdLst>/u.exec(savedList)?.[1])

			expect(parts?.refOf(part)).toBe(ref)
			expect(parts?.partOf(ref)).toBe(part)
			expect(parts?.slideId(ref)).toBe(id)

			// A duplicate's refs move into its saved part (a later edit splices it).
			if (how === "duplicate") {
				const picture = deck.nodes.get(ref)?.shapes.find(shape => shape.kind === "pic")

				expect(picture?.src).toMatchObject({ part, epoch: 1 })
			}

			expect(await h.command({ family: "slide", kind: "hide", slides: [ref], hidden: true })).toMatchObject({ ok: true })

			const shape = deck.nodes.get(ref)?.shapes[0]
			const xfrm: Xfrm = { x: 5, y: 6, cx: 700000, cy: 800000, rot: 0, flipH: false, flipV: false }

			expect(await h.command({ family: "shape", kind: "setXfrm", target: { slide: ref, id: shape?.id ?? 0 }, xfrm })).toMatchObject({
				ok: true
			})

			const again = await saveEdits(h, 2)

			expect(await changedParts(first, again)).toEqual([part.slice(1)])

			const back = await openDeck(again)
			const node = await back.parts.slide(back.deck.slides[2] ?? (0 as SlideRef))

			expect(node.hidden).toBe(true)
			expect(node.shapes[0]?.xfrm).toMatchObject({ x: 5, y: 6 })
		})
	}

	it("restores a slide deleted by a save with its notes and the picture the save removed", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const second = await h.slide(1)

		expect(await h.command({ family: "slide", kind: "delete", slides: [second.ref] })).toMatchObject({ ok: true })

		const first = await saveEdits(h, 1)

		expect((await partsOf(first)).has("ppt/media/image1.png")).toBe(false)

		await rebaseSession(h, pictureDeck(), first)
		expect(await h.undo()).toMatchObject({ ok: true })

		const again = await saveEdits(h, 2)

		expect(await danglingReferences(again)).toEqual([])

		const back = await openDeck(again)
		const restored = slideNodeAt(back, 1)
		const notes = back.deck.nodes.get(restored.notes ?? (0 as SlideRef))

		expect(back.deck.slides).toHaveLength(2)
		expect(restored.shapes.find(shape => shape.kind === "pic")).toBeDefined()
		expect((await partsOf(again)).has("ppt/media/image1.png")).toBe(true)
		expect(JSON.stringify(notes?.shapes)).toContain("Notes two")
	})

	it("drops a removed slide from the index on rebase", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const second = await h.slide(1)
		const part = second.part

		expect(await h.command({ family: "slide", kind: "delete", slides: [second.ref] })).toMatchObject({ ok: true })

		const saved = await saveEdits(h, 1)

		await rebaseSession(h, pictureDeck(), saved)

		expect(pptxParts(h.session.deck)?.refOf(part)).toBeUndefined()
		expect(pptxParts(h.session.deck)?.slideId(second.ref)).toBeUndefined()
	})
})
