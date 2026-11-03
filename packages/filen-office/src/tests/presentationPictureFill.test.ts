import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { FillProps, ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile, reopened } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { pictureDeck } from "./presentationObjectsFixtures"

// A fill set on a picture is the fill behind it (p:spPr, as PowerPoint's Picture Format ▸ Fill writes it): the save
// writes it and its check reads it there, the picture kept. A graphic frame (a chart, a table, a diagram) has no
// shape properties: a fill or outline on it is refused when given, never taken back at the save.

const GREEN: FillProps = { kind: "solid", color: { kind: "srgb", rgb: "00AA55" } }
const PLACEHOLDER = join(CORPUS_DIR, "pptx", "govuk__Ofqual_GCSE_A_level_grading_assembly_presentation.pptx")

async function text(bytes: Uint8Array, name: string): Promise<string> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const entry = zip.get(name)

	if (entry === undefined) throw new Error(`no ${name}`)

	return new TextDecoder().decode(await zip.read(entry))
}

describe("a fill behind a picture", () => {
	for (const fill of [GREEN, "none"] as const)
		it(`${fill === "none" ? "no fill" : "a solid fill"}: saved into the picture's p:spPr, its picture kept, the next save unchanged`, async () => {
			const d = await reopened(pictureDeck(), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const picture = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.kind === "pic") as ShapeNode

			expect((await d.command({ family: "shape", kind: "setProps", target: { slide, id: picture.id }, props: { fill } })).ok).toBe(
				true
			)

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")

			const markup = await text(saved.bytes as Uint8Array, "ppt/slides/slide1.xml")
			const pic = /<p:pic>[\s\S]*?<\/p:pic>/u.exec(markup)?.[0] ?? ""

			expect(pic).toContain('r:embed="rId9"')
			expect(/<p:spPr>[\s\S]*<\/p:spPr>/u.exec(pic)?.[0]).toContain(fill === "none" ? "<a:noFill/>" : '<a:srgbClr val="00AA55"')
			expect(await modelVsFile(d, saved.bytes as Uint8Array, "pptx")).toBe("")
			expect((await d.save()).result.kind).toBe("unchanged")
		})

	it("set, saved and undone: the next save takes it out again", async () => {
		const d = await reopened(pictureDeck(), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const picture = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.kind === "pic") as ShapeNode
		const before = await text(pictureDeck(), "ppt/slides/slide1.xml")

		expect((await d.command({ family: "shape", kind: "setProps", target: { slide, id: picture.id }, props: { fill: GREEN } })).ok).toBe(
			true
		)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)

		const undone = await d.save()

		expect(undone.result.kind).toBe("written")
		expect(await text(undone.bytes as Uint8Array, "ppt/slides/slide1.xml")).toBe(before)
	})

	it.skipIf(!existsSync(PLACEHOLDER))("on a picture placeholder of a source deck: saved", async () => {
		const d = await reopened(new Uint8Array(readFileSync(PLACEHOLDER)), "pptx")
		const slide = d.session.deck.slides[14] as SlideRef

		await review(d.context, slide)

		const picture = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.kind === "pic") as ShapeNode

		expect(picture).toBeDefined()
		expect((await d.command({ family: "shape", kind: "setProps", target: { slide, id: picture.id }, props: { fill: GREEN } })).ok).toBe(
			true
		)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		expect(await modelVsFile(d, saved.bytes as Uint8Array, "pptx")).toBe("")
	})
})

describe("a fill or outline on a graphic frame", () => {
	for (const props of [{ fill: GREEN }, { ln: { w: 12_700, fill: GREEN } }] as const)
		it(`${Object.keys(props)[0] ?? ""} on a chart: refused when given, the deck unchanged`, async () => {
			const d = await reopened(pictureDeck(), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)
			expect(
				(
					await d.command(
						insertChartOp(d.session.deck, slide, 0, "column", sampleChartCells({ categories: ["A"], series: ["N"] })) as DeckOp
					)
				).ok
			).toBe(true)

			const frame = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.frame?.kind === "chart") as ShapeNode
			const answer = await d.command({ family: "shape", kind: "setProps", target: { slide, id: frame.id }, props })

			expect(answer).toMatchObject({ ok: false, refusal: "unsupported" })
			expect(frame.props?.fill).toBeUndefined()
			expect((await d.save()).result.kind).toBe("written")
		})
})

describe("a fill or outline on an ODP page thumbnail", () => {
	const deck = (): Uint8Array =>
		odpBytes({
			body: '<draw:page draw:name="P1" draw:master-page-name="M"><draw:page-thumbnail draw:name="Thumb" draw:page-number="1" presentation:class="page" svg:x="1cm" svg:y="1cm" svg:width="8cm" svg:height="5cm"/></draw:page>'
		})

	for (const props of [{ fill: GREEN }, { ln: { w: 12_700, fill: GREEN } }] as const)
		it(`${Object.keys(props)[0] ?? ""}: refused when given, the deck unchanged`, async () => {
			const d = await driveSession(deck(), "odp")
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const thumbnail = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.ph?.type === "sldImg") as ShapeNode
			const answer = await d.command({ family: "shape", kind: "setProps", target: { slide, id: thumbnail.id }, props })

			expect(answer).toMatchObject({ ok: false, refusal: "unsupported" })
			expect((await d.save()).result.kind).toBe("unchanged")
		})
})
