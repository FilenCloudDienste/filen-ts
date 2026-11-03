import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { refused, type ShapeNode, type SlideNode, type SlideRef, type TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import type { DeckSaver, SaveDependencies } from "../dom/presentation/save"
import { modelVsFile } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A save the writer's check refuses for one edit takes back that edit only: the slide's other edits (typed text, a
// move, a fill on another shape) stay in the session, and the next save writes them.

type Format = "pptx" | "odp"

const typed = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })
const RED = { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } as const

function deckBytes(format: Format): Uint8Array {
	if (format === "pptx")
		return buildPptx({
			slides: [0, 1].map(at => ({
				shapes: [1, 2, 3]
					.map(n =>
						sp(
							n + 1,
							`Box ${String(n)}`,
							undefined,
							xfrm(100_000, n * 600_000, 3_000_000, 500_000),
							body(para(`S${String(at)}B${String(n)}`))
						)
					)
					.join("")
			}))
		})

	return odpBytes({
		body: [0, 1]
			.map(
				at =>
					`<draw:page draw:name="P${String(at)}" draw:master-page-name="M">` +
					[1, 2, 3]
						.map(
							n =>
								`<draw:frame draw:name="Box ${String(n)}" svg:x="1cm" svg:y="${String(n * 2)}cm" svg:width="5cm" svg:height="1cm"><draw:text-box><text:p>S${String(at)}B${String(n)}</text:p></draw:text-box></draw:frame>`
						)
						.join("") +
					"</draw:page>"
			)
			.join("")
	})
}

// What each format's writer check says when a shape's group reads back otherwise (verify.ts, odp meaning.ts).
function detailOf(format: Format, node: SlideNode, index: number, what: "fill" | "text"): string {
	const shape = node.shapes[index] as ShapeNode

	if (format === "pptx")
		return `${node.part} reads back differently at .shapes[${String(index)}].${what === "fill" ? "fill.kind" : "text.paragraphs[0].runs"}`

	return `page 1 (${node.part}) reads back differently: shape ${String(index)} (${String(shape.name)}) ${what === "fill" ? "fill" : "paragraph 0 endRPr"}`
}

// The format's saver with a writer whose check refuses the next snapshot once, with `detail`.
function refusingOnce(format: Format, detail: () => string): (dependencies: SaveDependencies) => SaveDependencies {
	let armed = true

	return dependencies => {
		const saver = dependencies.savers[format] as DeckSaver<unknown>
		const writer: DeckSaver<unknown>["writer"] = {
			write: saver.writer.write.bind(saver.writer),
			snapshot: async input => {
				const snapshot = await saver.writer.snapshot(input)

				if (!armed || ("kind" in snapshot && snapshot.kind === "refused")) return snapshot

				armed = false

				return refused("proofFailed", detail())
			}
		}

		return { ...dependencies, savers: { ...dependencies.savers, [format]: { ...saver, writer } } }
	}
}

const textOf = (shape: ShapeNode | undefined): string =>
	(shape?.text?.paragraphs ?? []).map(paragraph => paragraph.runs.map(run => ("text" in run ? run.text : "")).join("")).join("\n")

describe("a save refused for one edit", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: takes back only the fill the writer refused; the typed title, the move and the other slide's edit stay`, async () => {
			let detail = ""
			const events: { type: string; notice?: unknown }[] = []
			const d = await driveSession(deckBytes(format), format, events, { dependencies: refusingOnce(format, () => detail) })
			const [slide, other] = d.session.deck.slides as [SlideRef, SlideRef]

			await review(d.context, slide)
			await review(d.context, other)

			const node = (): SlideNode => d.session.deck.nodes.get(slide) as SlideNode
			const [first, second, third] = node().shapes as [ShapeNode, ShapeNode, ShapeNode]
			const ops: DeckOp[] = [
				{ family: "text", kind: "setText", target: { slide, id: first.id }, body: typed("My title") },
				{
					family: "shape",
					kind: "setXfrm",
					target: { slide, id: second.id },
					xfrm: { ...(second.xfrm as NonNullable<ShapeNode["xfrm"]>), x: 254_000 }
				},
				{ family: "shape", kind: "setProps", target: { slide, id: third.id }, props: { fill: RED } } as DeckOp,
				{ family: "text", kind: "setText", target: { slide, id: second.id }, body: typed("After the fill") },
				{
					family: "text",
					kind: "setText",
					target: { slide: other, id: (d.session.deck.nodes.get(other) as SlideNode).shapes[0]?.id as number },
					body: typed("Other")
				}
			]

			for (const op of ops) expect((await d.command(op)).ok).toBe(true)

			detail = detailOf(format, node(), 2, "fill")

			const refusedSave = await d.save()

			expect(refusedSave.result).toMatchObject({ kind: "refused", reason: "proofFailed" })
			expect(events.filter(event => event.type === "notice").map(event => event.notice)).toContainEqual({
				kind: "saveReverted",
				ops: 1
			})

			const [title, moved, filled] = node().shapes as [ShapeNode, ShapeNode, ShapeNode]

			expect(textOf(title)).toBe("My title")
			expect(moved.xfrm?.x).toBe(254_000)
			expect(textOf(moved)).toBe("After the fill")
			expect(filled.props?.fill).not.toEqual(RED)
			expect(textOf((d.session.deck.nodes.get(other) as SlideNode).shapes[0])).toBe("Other")

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect(await modelVsFile(d, saved.bytes as Uint8Array, format)).toBe("")
		})

		it(`${format}: typed text the writer refused is taken back alone; a fill on the same shape stays`, async () => {
			let detail = ""
			const events: { type: string; notice?: unknown }[] = []
			const d = await driveSession(deckBytes(format), format, events, { dependencies: refusingOnce(format, () => detail) })
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const node = (): SlideNode => d.session.deck.nodes.get(slide) as SlideNode
			const shape = node().shapes[1] as ShapeNode

			expect(
				(await d.command({ family: "shape", kind: "setProps", target: { slide, id: shape.id }, props: { fill: RED } } as DeckOp)).ok
			).toBe(true)
			expect((await d.command({ family: "text", kind: "setText", target: { slide, id: shape.id }, body: typed("Typed") })).ok).toBe(
				true
			)

			detail = detailOf(format, node(), 1, "text")
			expect((await d.save()).result).toMatchObject({ kind: "refused", reason: "proofFailed" })

			const after = node().shapes[1] as ShapeNode

			expect(after.props?.fill).toEqual(RED)
			expect(textOf(after)).not.toBe("Typed")
		})

		it(`${format}: a slide's own state the writer refused (hidden) is taken back alone; its typed text stays`, async () => {
			let detail = ""
			const events: { type: string; notice?: unknown }[] = []
			const d = await driveSession(deckBytes(format), format, events, { dependencies: refusingOnce(format, () => detail) })
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const node = (): SlideNode => d.session.deck.nodes.get(slide) as SlideNode
			const shape = node().shapes[0] as ShapeNode

			expect((await d.command({ family: "text", kind: "setText", target: { slide, id: shape.id }, body: typed("Typed") })).ok).toBe(
				true
			)
			expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

			detail =
				format === "pptx"
					? `${node().part} reads back differently at .hidden`
					: `page 1 (${node().part}) reads back differently: hidden`
			expect((await d.save()).result).toMatchObject({ kind: "refused", reason: "proofFailed" })
			expect(node().hidden).not.toBe(true)
			expect(textOf(node().shapes[0])).toBe("Typed")
		})
	}
})
