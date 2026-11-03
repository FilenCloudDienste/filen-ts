import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Paragraph, RunProps, ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile, reopened } from "./modelVsFile"
import { body, buildPptx, sp, xfrm } from "./pptxFixtures"

// A run whose link the app refuses to follow (a file, a program) is kept byte for byte; formatting part of it splits
// it, and both runs keep the link as PowerPoint does, so the deck saves.

const LINKED =
	'<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId7" action="ppaction://hlinkfile"/></a:rPr><a:t>Linked words</a:t></a:r></a:p>'

const ATTACHMENTS = join(CORPUS_DIR, "pptm", "poi__PPTWithAttachments.pptm")

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(LINKED)),
				rels: [["rId7", "hyperlink", "file:///C:/notes.txt", "External"]]
			}
		]
	})
}

describe("a run with a refused link, part of it formatted", () => {
	for (const at of ["end", "start", "middle"] as const)
		it(`bold at the ${at}: saved, both runs keep the link`, async () => {
			const d = await reopened(deck(), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode
			const paragraph = shape.text?.paragraphs[0] as Paragraph
			const run = paragraph.runs[0] as Extract<Paragraph["runs"][number], { kind: "r" }>
			const bold: RunProps = { ...run.rPr, b: true }
			const pieces =
				at === "end"
					? [
							{ ...run, text: "Linked " },
							{ ...run, text: "words", rPr: bold }
						]
					: at === "start"
						? [
								{ ...run, text: "Linked", rPr: bold },
								{ ...run, text: " words" }
							]
						: [
								{ ...run, text: "Li" },
								{ ...run, text: "nked", rPr: bold },
								{ ...run, text: " words" }
							]

			expect(run.rPr.hlinkClick?.kind).toBe("refused")
			expect(
				(
					await d.command({
						family: "text",
						kind: "setText",
						target: { slide, id: shape.id },
						body: { ...(shape.text as NonNullable<ShapeNode["text"]>), paragraphs: [{ ...paragraph, runs: pieces }] }
					})
				).ok
			).toBe(true)

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect(await modelVsFile(d, saved.bytes as Uint8Array, "pptx")).toBe("")

			const again = await reopened(saved.bytes as Uint8Array, "pptx")
			const ref = again.session.deck.slides[0] as SlideRef

			await review(again.context, ref)

			const runs = ((again.session.deck.nodes.get(ref) as SlideNode).shapes[0] as ShapeNode).text?.paragraphs[0]?.runs ?? []

			expect(runs.map(each => (each.kind === "r" ? each.rPr.hlinkClick : undefined))).toEqual(pieces.map(() => run.rPr.hlinkClick))
			expect((await again.save()).result.kind).toBe("unchanged")
		})

	it.skipIf(!existsSync(ATTACHMENTS))("a title of file links, its first run split: saved, the next save unchanged", async () => {
		const d = await reopened(new Uint8Array(readFileSync(ATTACHMENTS)), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.id === 2050) as ShapeNode
		const text = shape.text as NonNullable<ShapeNode["text"]>
		const paragraph = text.paragraphs[0] as Paragraph
		const run = paragraph.runs[0] as Extract<Paragraph["runs"][number], { kind: "r" }>

		expect(run.rPr.hlinkClick?.kind).toBe("refused")
		expect(
			(
				await d.command({
					family: "text",
					kind: "setText",
					target: { slide, id: shape.id },
					body: {
						...text,
						paragraphs: [
							{
								...paragraph,
								runs: [
									{ ...run, text: run.text.slice(0, 3) },
									{ ...run, text: run.text.slice(3), rPr: { ...run.rPr, b: true } },
									...paragraph.runs.slice(1)
								]
							},
							...text.paragraphs.slice(1)
						]
					}
				})
			).ok
		).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		expect(await modelVsFile(d, saved.bytes as Uint8Array, "pptx")).toBe("")
		expect((await d.save()).result.kind).toBe("unchanged")
	})
})
