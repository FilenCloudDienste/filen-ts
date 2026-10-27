import { describe, expect, it } from "vitest"
import { prepareOdpPictureOp } from "../core/odp/write/emit/picture"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { odpBytes } from "./odpFixtures"
import { changes, entriesOf, odpApplier, openOdpDeck, saveDeck, slideAt, text } from "./odpWriteFixtures"
import { png } from "./presentationObjectsFixtures"

// A picture an ODP file already holds is cropped and adjusted in its frame's graphic style: fo:clip in points of the
// image's own size (read from the Pictures/ entry's header) and the adjustments, saved at once, read back as applied.

const PICTURE =
	'<draw:frame draw:name="Cat" draw:style-name="gr1" svg:x="2cm" svg:y="4cm" svg:width="8cm" svg:height="4cm">' +
	'<draw:image xlink:href="Pictures/cat.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><text:p/></draw:image>' +
	"<svg:title>A cat</svg:title></draw:frame>"

function deck(): Uint8Array {
	return odpBytes({
		automatic:
			'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>',
		body: `<draw:page draw:name="One" draw:master-page-name="M">${PICTURE}</draw:page>`,
		extra: [{ name: "Pictures/cat.png", data: png(200, 100), mediaType: "image/png" }]
	})
}

async function edited(
	op: (target: { readonly slide: SlideRef; readonly id: number }) => DeckOp
): Promise<{ readonly content: string; readonly shape: ShapeNode }> {
	const opened = await openOdpDeck(deck())
	const node = slideAt(opened, 0)
	const shape = node.shapes.find(each => each.kind === "pic")

	if (shape === undefined) throw new Error("no picture")

	const edit = op({ slide: node.ref, id: shape.id })

	// What the engine does before the op applies.
	await prepareOdpPictureOp(opened.deck, edit, opened.parts.opc)
	expect(odpApplier(opened)(edit)).toBeUndefined()

	const { outcome, bytes } = await saveDeck(opened, changes())

	expect(outcome).toMatchObject({ kind: "written" })

	const reopened = await openOdpDeck(bytes ?? new Uint8Array())
	const back = slideAt(reopened, 0).shapes.find(each => each.kind === "pic")

	if (back === undefined) throw new Error("no picture after the save")

	return { content: text((await entriesOf(bytes ?? new Uint8Array())).get("content.xml")), shape: back }
}

describe("odp source pictures", () => {
	it("crops a source picture by its image's own size and reads the crop back", async () => {
		const { content, shape } = await edited(target => ({
			family: "picture",
			kind: "crop",
			target,
			crop: { l: 0, t: 0, r: 50_000, b: 10_000 }
		}))

		// 200 × 100 px at 96 dpi: half the width is 75pt, a tenth of the height 7.5pt.
		expect(content).toMatch(/fo:clip="rect\(0pt, 75pt, 7\.5pt, 0pt\)"/u)
		expect(content).toContain('xlink:href="Pictures/cat.png"')
		expect(shape.props?.fill).toMatchObject({ kind: "picture", crop: { l: 0, t: 0, r: 50_000, b: 10_000 } })
	})

	it("adjusts a source picture in its graphic style, keeps its image and reads the adjustments back", async () => {
		const { content, shape } = await edited(target => ({
			family: "picture",
			kind: "adjust",
			target,
			adjust: { grayscale: true, brightness: 20_000 }
		}))

		expect(content).toContain('draw:color-mode="greyscale"')
		expect(content).toContain('draw:luminance="20%"')
		expect(content).toContain('xlink:href="Pictures/cat.png"')
		// Read back as applied.
		expect(shape.props?.fill).toMatchObject({ kind: "picture", adjust: { grayscale: true, brightness: 20_000 } })
	})

	it("refuses at the command the crop of a picture whose image size cannot be read, never at the save", async () => {
		const opened = await openOdpDeck(
			odpBytes({
				body: `<draw:page draw:name="One" draw:master-page-name="M">${PICTURE}</draw:page>`,
				extra: [{ name: "Pictures/cat.png", data: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png" }]
			})
		)
		const node = slideAt(opened, 0)
		const shape = node.shapes.find(each => each.kind === "pic")
		const edit: DeckOp = {
			family: "picture",
			kind: "crop",
			target: { slide: node.ref, id: shape?.id ?? -1 },
			crop: { l: 10_000, t: 0, r: 0, b: 0 }
		}

		await prepareOdpPictureOp(opened.deck, edit, opened.parts.opc)

		expect(odpApplier(opened)(edit)).toMatchObject({ kind: "refused", reason: "unsupported" })
	})
})
