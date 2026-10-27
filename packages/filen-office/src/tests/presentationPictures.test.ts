import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { viewCapability } from "../dom/presentation/engine/view"
import { readBlipFill } from "../core/pptx/read/drawing"
import { G, partReader } from "../core/pptx/read/xml"
import { applyPicture, insertedImage, pictureFillOf, type PictureReading } from "../core/presentation/edit/apply/picture"
import type { ShapeNode } from "../core/presentation/model"
import { image, pictureDeck } from "./presentationObjectsFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { changedParts, openDeck, partsOf, saveEdits, slideNode, text } from "./pptxWriteFixtures"

// Picture edits end to end: an inserted image lives in the deck's registry until a save stores it as a new image part
// related from its slide; crop, adjustments and Change Picture write the picture's p:blipFill from its typed fill,
// keeping what the model does not hold of the source a:blip; undo puts the source fill back.

const EDIT = { emit: emitPptx } as never

function picShape(id = 0): ShapeNode {
	return {
		id,
		name: "Picture",
		hidden: false,
		kind: "pic",
		alt: { descr: "Inserted" },
		xfrm: { x: 500, y: 600, cx: 2000, cy: 1000, rot: 0, flipH: false, flipV: false }
	}
}

describe("picture edits", () => {
	it("inserts an image that a save stores as a new part related from its slide", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const result = await h.command({ family: "picture", kind: "insert", slide, shape: picShape(), image: image() })

		expect(result.ok).toBe(true)

		const shapes = (await h.slide(0)).shapes
		const inserted = shapes[shapes.length - 1] as ShapeNode
		const fill = pictureFillOf(inserted)

		expect(fill?.inserted).toBeGreaterThan(0)
		expect(insertedImage(h.session.deck, fill?.inserted ?? 0)?.contentType).toBe("image/png")

		const saved = await saveEdits(h, (result as { revision: number }).revision)
		const parts = await partsOf(saved)
		const media = [...parts.keys()].filter(name => name.startsWith("ppt/media/"))

		expect(media.length).toBe(2)
		expect(text(parts.get("ppt/slides/_rels/slide1.xml.rels"))).toMatch(/Target="\.\.\/media\/image2\.png"/u)
		expect(text(parts.get("ppt/slides/slide1.xml"))).toContain('descr="Inserted"')
		expect(text(parts.get("[Content_Types].xml"))).toContain("png")

		const reopened = await openDeck(saved)
		const pic = slideNode(reopened, 0).shapes.find(shape => shape.name === "Picture")

		expect(pic?.kind).toBe("pic")
		expect(pic?.xfrm).toMatchObject({ x: 500, y: 600, cx: 2000, cy: 1000 })
	})

	it("crops and adjusts an inserted picture, and undoes back to the plain insert", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const inserted = await h.command({ family: "picture", kind: "insert", slide, shape: picShape(), image: image() })
		const shapes = (await h.slide(0)).shapes
		const id = (shapes[shapes.length - 1] as ShapeNode).id
		const target = { slide, id }

		expect(inserted.ok).toBe(true)
		expect((await h.command({ family: "picture", kind: "crop", target, crop: { l: 10_000, t: 0, r: 5_000, b: 0 } })).ok).toBe(true)

		const adjusted = await h.command({ family: "picture", kind: "adjust", target, adjust: { brightness: 20_000, grayscale: true } })
		const saved = await saveEdits(h, (adjusted as { revision: number }).revision)
		const slideXml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(slideXml).toContain('<a:grayscl/><a:lum bright="20000"/></a:blip><a:srcRect l="10000" t="0" r="5000" b="0"/>')

		await h.undo()
		await h.undo()
		expect(pictureFillOf(shapeById((await h.slide(0)).shapes, id) as ShapeNode)?.crop).toBeUndefined()
	})

	it("crops a source picture from its source fill, keeping the blip's extension list", async () => {
		const opened = await openDeck(pictureDeck())
		const node = slideNode(opened, 0)
		const document = opened.parts.document(node.part)

		if (document === undefined) throw new Error("no document")

		const relationships = await opened.parts.opc.relationships(node.part.slice(1))
		const context: PictureReading = {
			sourceBytes: () => new Uint8Array(0),
			newShapeId: () => 99,
			newSlideRef: () => 0 as never,
			pictureFill: (_slide, shape) => {
				const r = partReader(document)

				return readBlipFill(
					{ reader: r, part: node.part, epoch: 0, relationships, tally: opened.parts.tally, action: () => undefined },
					r.child(shape.src?.node ?? -1, G.P, "blipFill")
				) as never
			}
		}
		const result = applyPicture.apply(
			opened.deck,
			{ family: "picture", kind: "crop", target: { slide: node.ref, id: 4 }, crop: { l: 0, t: 25_000, r: 0, b: 25_000 } },
			context
		)

		expect(result.kind).toBe("applied")

		const fill = pictureFillOf(shapeById(node.shapes, 4) as ShapeNode)

		expect(fill).toMatchObject({ part: "/ppt/media/image1.png", crop: { t: 25_000, b: 25_000 } })
	})

	it("refuses an image type the deck cannot hold, an empty image and a crop past the picture", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never

		expect(
			await h.command({
				family: "picture",
				kind: "insert",
				slide,
				shape: picShape(),
				image: { ...image(), contentType: "image/x-icon" }
			})
		).toMatchObject({ ok: false, refusal: "unsupported" })
		expect(
			await h.command({ family: "picture", kind: "insert", slide, shape: picShape(), image: { ...image(), width: 0 } })
		).toMatchObject({
			ok: false,
			refusal: "malformed"
		})
		expect(
			await h.command({ family: "picture", kind: "crop", target: { slide, id: 4 }, crop: { l: 60_000, t: 0, r: 50_000, b: 0 } })
		).toMatchObject({ ok: false, refusal: "malformed" })
	})

	it("saves a moved source picture without touching its image", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const moved = await h.command({
			family: "shape",
			kind: "setXfrm",
			target: { slide, id: 4 },
			xfrm: { x: 900, y: 100, cx: 2000, cy: 1000, rot: 0, flipH: false, flipV: false }
		})
		const saved = await saveEdits(h, (moved as { revision: number }).revision)

		expect(await changedParts(pictureDeck(), saved)).toEqual(["ppt/slides/slide1.xml"])
	})

	it("crops a source picture through the session, keeping its image and the blip's extension list", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const cropped = await h.command({
			family: "picture",
			kind: "crop",
			target: { slide, id: 4 },
			crop: { l: 0, t: 25_000, r: 0, b: 25_000 }
		})

		expect(cropped.ok).toBe(true)

		const saved = await saveEdits(h, (cropped as { revision: number }).revision)
		const slideXml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(await changedParts(pictureDeck(), saved)).toEqual(["ppt/slides/slide1.xml"])
		expect(slideXml).toContain('<a:blip r:embed="rId9"><a:extLst>')
		expect(slideXml).toContain('<a:srcRect l="0" t="25000" r="0" b="25000"/><a:stretch><a:fillRect/></a:stretch>')

		expect((await h.undo()).ok).toBe(true)
		expect(pictureFillOf(shapeById((await h.slide(0)).shapes, 4) as ShapeNode)).toBeUndefined()
	})

	it("serves an inserted image to the painter before any save", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const inserted = image()

		expect((await h.command({ family: "picture", kind: "insert", slide, shape: picShape(), image: inserted })).ok).toBe(true)

		const shapes = (await h.slide(0)).shapes
		const id = pictureFillOf(shapes[shapes.length - 1] as ShapeNode)?.inserted ?? 0
		const served = await viewCapability.image(h.context, `inserted:${String(id)}`)

		expect(served?.type).toBe("image/png")
		expect([...(served?.bytes ?? [])]).toEqual([...inserted.bytes])
		// A copy: the answer's bytes are transferred, the registry keeps its own.
		expect(served?.bytes).not.toBe(insertedImage(h.session.deck, id)?.bytes)
	})

	it("draws an inserted picture as its image before any save, never as a missing one", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const result = await h.command({ family: "picture", kind: "insert", slide, shape: picShape(), image: image() })

		expect(result.ok).toBe(true)

		const [render] = await viewCapability.render(h.context, [slide])
		const drawn = render?.layers.flatMap(layer => layer.drawing.images).find(each => each.partName?.startsWith("inserted:") === true)

		expect(drawn?.format).toBe("png")
	})

	it("draws an adjusted picture with its adjustments", async () => {
		const h = await editHarness(pictureDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const result = await h.command({
			family: "picture",
			kind: "adjust",
			target: { slide, id: 4 },
			adjust: { grayscale: true, brightness: 30_000 }
		})

		expect(result.ok).toBe(true)

		const [render] = await viewCapability.render(h.context, [slide])
		const drawn = render?.layers.flatMap(layer => layer.drawing.images).find(each => each.partName === "/ppt/media/image1.png")

		expect(drawn?.grayscale).toBe(true)
		expect(drawn?.brightness).toBeCloseTo(0.3, 3)
	})
})
