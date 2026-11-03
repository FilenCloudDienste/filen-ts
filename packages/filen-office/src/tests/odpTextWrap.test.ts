import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes, openOdpFixture, slideOf } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// fo:wrap-option (ODF 1.3 §20.395) as LibreOffice 7.5 lays text out by it (measured: each case below as a page of its
// own, the PDF it exports counted for lines): a text frame (draw:frame with draw:text-box, a presentation object or
// not) wraps whatever the option says, unless it grows with its text (draw:auto-grow-width); a custom shape takes the
// option from its styles, never from the graphic default style (which LibreOffice writes as no-wrap); the other
// drawing shapes take it from their whole chain.

const LONG = "A long line of text that runs well past the right edge of its box unless something wraps it"
const GEOMETRY =
	'<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 0 0 Z N"/>'
const BOX = 'svg:x="1cm" svg:y="1cm" svg:width="8cm" svg:height="4cm"'

const frame = (name: string, attributes: string): string =>
	`<draw:frame draw:name="${name}" ${attributes} ${BOX}><draw:text-box><text:p>${LONG}</text:p></draw:text-box></draw:frame>`
const custom = (name: string, style: string): string =>
	`<draw:custom-shape draw:name="${name}" draw:style-name="${style}" ${BOX}><text:p>${LONG}</text:p>${GEOMETRY}</draw:custom-shape>`
const drawn = (tag: string, name: string, style: string): string =>
	`<${tag} draw:name="${name}" draw:style-name="${style}" ${BOX}><text:p>${LONG}</text:p></${tag}>`

const DECK = {
	styles:
		'<style:default-style style:family="graphic"><style:graphic-properties fo:wrap-option="no-wrap"/></style:default-style>' +
		'<style:style style:name="NoWrap" style:family="graphic"><style:graphic-properties fo:wrap-option="no-wrap"/></style:style>',
	automatic:
		'<style:style style:name="gn" style:family="graphic"><style:graphic-properties fo:wrap-option="no-wrap"/></style:style>' +
		'<style:style style:name="g0" style:family="graphic"><style:graphic-properties draw:fill="none"/></style:style>' +
		'<style:style style:name="gp" style:family="graphic" style:parent-style-name="NoWrap"><style:graphic-properties draw:fill="none"/></style:style>' +
		'<style:style style:name="ga" style:family="graphic"><style:graphic-properties fo:wrap-option="wrap" draw:auto-grow-width="true"/></style:style>',
	body:
		'<draw:page draw:name="P1" draw:master-page-name="M">' +
		frame("outline", 'presentation:class="outline"') +
		frame("frame own no-wrap", 'draw:style-name="gn"') +
		frame("frame grows", 'draw:style-name="ga"') +
		custom("custom own no-wrap", "gn") +
		custom("custom default", "g0") +
		custom("custom parent no-wrap", "gp") +
		drawn("draw:rect", "rect own no-wrap", "gn") +
		drawn("draw:ellipse", "ellipse default", "g0") +
		"</draw:page>"
}

const WRAPS: Readonly<Record<string, boolean>> = {
	outline: true,
	"frame own no-wrap": true,
	"frame grows": false,
	"custom own no-wrap": false,
	"custom default": true,
	"custom parent no-wrap": false,
	"rect own no-wrap": false,
	"ellipse default": false
}

const wrapOf = (shape: ShapeNode | undefined): boolean | undefined => shape?.text?.bodyPr.wrap ?? shape?.props?.bodyPr?.wrap

describe("ODP text wrapping as LibreOffice lays it out", () => {
	it("reads each shape's wrap by its kind and where its option comes from", async () => {
		const slide = await slideOf(await openOdpFixture(DECK), 0)

		expect(Object.fromEntries(slide.shapes.map(shape => [shape.name, wrapOf(shape)]))).toEqual(WRAPS)
	})

	it("keeps the styles as they were when a frame's text is edited, and reads it wrapped again", async () => {
		const source = odpBytes(DECK)
		const d = await driveSession(source, "odp")
		const ref = d.session.deck.slides[0] as SlideRef

		await review(d.context, ref)

		const outline = d.session.deck.nodes.get(ref)?.shapes.find(shape => shape.name === "outline") as ShapeNode
		const text = outline.text as NonNullable<ShapeNode["text"]>

		expect(
			(
				await d.command({
					family: "text",
					kind: "setText",
					target: { slide: ref, id: outline.id },
					body: { ...text, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: `${LONG} again`, rPr: {} }] }] }
				})
			).ok
		).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const read = async (bytes: Uint8Array, name: string): Promise<string> => {
			const zip = await ZipArchive.open(bytesSource(bytes))

			return new TextDecoder().decode(await zip.read(zip.get(name) as NonNullable<ReturnType<ZipArchive["get"]>>))
		}

		expect(await read(saved.bytes as Uint8Array, "styles.xml")).toBe(await read(source, "styles.xml"))
		const count = (markup: string, what: string): number => markup.split(what).length - 1
		const before = await read(source, "content.xml")
		const after = await read(saved.bytes as Uint8Array, "content.xml")

		for (const what of ["fo:wrap-option", "draw:auto-grow-width"]) expect(count(after, what)).toBe(count(before, what))

		const again = await openOdpFixture(DECK)

		expect(wrapOf((await slideOf(again, 0)).shapes[0])).toBe(true)
	})

	it("writes a text box inserted not to wrap as a frame that grows with its text, and reads it so", async () => {
		const d = await driveSession(odpBytes(DECK), "odp")
		const ref = d.session.deck.slides[0] as SlideRef

		await review(d.context, ref)

		const box: ShapeNode = {
			id: 50,
			name: "no wrap",
			hidden: false,
			kind: "sp",
			txBox: true,
			xfrm: { x: 360_000, y: 3_600_000, cx: 1_800_000, cy: 360_000, rot: 0, flipH: false, flipV: false },
			text: { bodyPr: { wrap: false, autofit: "none" }, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: LONG, rPr: {} }] }] }
		}

		expect((await d.command({ family: "shape", kind: "insert", slide: ref, shape: box } as DeckOp)).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const again = await driveSession(saved.bytes as Uint8Array, "odp")
		const back = again.session.deck.slides[0] as SlideRef

		await review(again.context, back)

		const read = again.session.deck.nodes.get(back)?.shapes.find(shape => shape.name === "no wrap")

		expect(read?.kind).toBe("sp")
		expect(wrapOf(read)).toBe(false)
	})
})
