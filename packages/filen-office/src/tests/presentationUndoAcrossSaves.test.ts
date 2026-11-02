import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { smartartCapability } from "../dom/presentation/engine/smartart"
import type { SmartArtInfo } from "../core/smartart/edit"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile, reopened } from "./modelVsFile"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"

// Undo across saves that left a slide's parts out (its slide deleted and saved): every save after it is written, and
// the file shows what the session shows (notes, diagrams, pictures), checked against a fresh open of the file.

type Drive = Awaited<ReturnType<typeof reopened>>

const BOX: Xfrm = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
const STRIP = join(CORPUS_DIR, "pptx", "lo__smartart-picture-strip.pptx")
const PIE = join(CORPUS_DIR, "pptx", "lo__tdf149551_SmartArt_Pie.pptx")

const notes = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })

async function command(d: Drive, op: DeckOp): Promise<void> {
	if ("slide" in op && typeof op.slide === "number") await review(d.context, op.slide)
	if ("target" in op) await review(d.context, (op as { readonly target: { readonly slide: SlideRef } }).target.slide)

	expect((await d.command(op)).ok, `${op.family}.${op.kind}`).toBe(true)
}

// A save that is written or has nothing to write; written, the file is whole and shows the session's deck.
async function saved(d: Drive): Promise<void> {
	const result = await d.save()

	expect(["written", "unchanged"], JSON.stringify(result.result)).toContain(result.result.kind)

	if (result.bytes === undefined) return

	expect(await danglingReferences(result.bytes)).toEqual([])
	expect(await modelVsFile(d, result.bytes, "pptx")).toBe("")
}

async function undoAll(d: Drive): Promise<void> {
	for (let step = 0; step < 100 && (await d.undo()).ok; step++);
}

describe("undo across saves that left parts out", () => {
	it("pptx: notes made and saved, the slide deleted and saved, everything undone: the file has no notes either", async () => {
		const d = await reopened(
			buildPptx({
				slides: [0, 1, 2].map(at => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
				}))
			}),
			"pptx"
		)
		const slide = d.session.deck.slides[1] as SlideRef

		await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Secret") })
		await saved(d)
		await command(d, { family: "slide", kind: "delete", slides: [slide] })
		await saved(d)
		await undoAll(d)
		await saved(d)
	})

	it.skipIf(!existsSync(STRIP))(
		"pptx: a picture set, the diagram's slide copied and the original deleted and saved, undone step by step, redone and let go: every save written",
		async () => {
			const d = await reopened(new Uint8Array(readFileSync(STRIP)), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })
			await saved(d)

			const frame = (d.session.deck.nodes.get(slide)?.shapes ?? []).find(shape => shape.frame?.kind === "smartart") as ShapeNode

			await command(d, {
				family: "smartart",
				kind: "setPicture",
				target: { slide, id: frame.id },
				node: "{6C48A404-2A3A-41E9-9551-8F4435666C27}",
				placeholder: "rect2",
				image: image(27, 10)
			})
			await command(d, { family: "slide", kind: "duplicate", slide })
			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await saved(d)

			for (let step = 0; step < 5; step++) {
				await d.undo()
				await saved(d)
			}

			for (let step = 0; step < 100 && (await d.redo()).ok; step++);

			await saved(d)

			// The history let go: what the deck shows is all that is named.
			const first = d.session.deck.slides[0] as SlideRef

			for (let at = 0; at <= 500; at++) await d.command({ family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

			await saved(d)
		}
	)

	for (const hide of [false, true])
		it.skipIf(!existsSync(STRIP))(
			`pptx: a picture set, the slide copied and the original deleted and saved, one undo${hide ? ", the slide hidden" : ""}, undone to the start, redone and let go: every save written`,
			async () => {
				const d = await reopened(new Uint8Array(readFileSync(STRIP)), "pptx")
				const slide = d.session.deck.slides[0] as SlideRef

				await review(d.context, slide)

				const frame = (d.session.deck.nodes.get(slide)?.shapes ?? []).find(shape => shape.frame?.kind === "smartart") as ShapeNode

				await command(d, {
					family: "smartart",
					kind: "setPicture",
					target: { slide, id: frame.id },
					node: "{6C48A404-2A3A-41E9-9551-8F4435666C27}",
					placeholder: "rect2",
					image: image(27, 10)
				})
				await command(d, { family: "slide", kind: "duplicate", slide })
				await command(d, { family: "slide", kind: "delete", slides: [slide] })
				await saved(d)
				await d.undo()

				if (hide) await command(d, { family: "slide", kind: "hide", slides: [slide], hidden: true })

				await saved(d)
				await undoAll(d)
				await saved(d)

				for (let step = 0; step < 100 && (await d.redo()).ok; step++);

				const first = d.session.deck.slides[0] as SlideRef

				for (let at = 0; at <= 500; at++) await d.command({ family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

				await saved(d)
			}
		)

	it.skipIf(!existsSync(PIE))(
		"pptx: diagrams inserted and undone across saves, a picture undone, the slide copied and deleted, undone and redone: every save written",
		async () => {
			const d = await reopened(new Uint8Array(readFileSync(PIE)), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef
			const diagram = (name: string, layout: string): DeckOp => ({
				family: "smartart",
				kind: "insert",
				slide,
				shape: { id: 0, name, hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
				layout: { uniqueId: `urn:filen:smartart:layout:${layout}`, source: "gallery" },
				texts: ["Alpha", "Beta", "Gamma"]
			})

			await command(d, diagram("Dia19", "pyramid-basic"))
			await saved(d)
			await d.undo()
			await saved(d)
			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes 30") })
			await command(d, {
				family: "picture",
				kind: "insert",
				slide,
				shape: { id: 0, name: "Pic31", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
				image: image(39, 8)
			})
			await d.undo()
			await saved(d)
			await command(d, diagram("Dia35", "process-basic"))
			await command(d, { family: "slide", kind: "duplicate", slide })
			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await saved(d)
			await undoAll(d)
			await saved(d)

			for (let step = 0; step < 100 && (await d.redo()).ok; step++);

			await saved(d)

			const first = d.session.deck.slides[0] as SlideRef

			for (let at = 0; at <= 500; at++) await d.command({ family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

			await saved(d)
		}
	)

	it("pptx: a diagram inserted and restyled on a saved copy, a picture and a chart on the original, undone to the start and redone: every save written", async () => {
		const d = await reopened(
			buildPptx({
				slides: [0, 1, 2].map(at => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
				}))
			}),
			"pptx"
		)
		const slide = d.session.deck.slides[0] as SlideRef

		await command(d, { family: "slide", kind: "duplicate", slide })

		const copy = d.session.deck.slides[1] as SlideRef

		await command(d, { family: "notes", kind: "setNotes", slide: copy, body: notes("Notes 1") })
		await saved(d)
		await command(d, {
			family: "smartart",
			kind: "insert",
			slide: copy,
			shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
			layout: { uniqueId: "urn:filen:smartart:layout:picture-caption-list", source: "gallery" },
			texts: ["Alpha", "Beta", "Gamma"]
		})

		const diagram = (d.session.deck.nodes.get(copy)?.shapes ?? []).find(shape => shape.frame?.kind === "smartart") as ShapeNode

		await command(d, {
			family: "smartart",
			kind: "setStyle",
			target: { slide: copy, id: diagram.id },
			def: { uniqueId: "urn:filen:smartart:style:intense", source: "gallery" }
		})
		await command(d, {
			family: "picture",
			kind: "insert",
			slide,
			shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
			image: image(30, 8)
		})
		await command(d, insertChartOp(d.session.deck, slide, 0, "column", sampleChartCells({ categories: ["A", "B"], series: ["North"] })))
		await saved(d)
		await undoAll(d)
		await saved(d)

		for (let step = 0; step < 100 && (await d.redo()).ok; step++);

		await saved(d)

		for (let at = 0; at <= 500; at++) await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: at % 2 === 0 })

		await saved(d)
	})

	it.skipIf(!existsSync(PIE))(
		"pptx: a diagram's slide copied, the original deleted and saved, the delete undone: its text pane reads",
		async () => {
			const d = await reopened(new Uint8Array(readFileSync(PIE)), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			await command(d, { family: "slide", kind: "duplicate", slide })
			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await saved(d)
			expect((await d.undo()).ok).toBe(true)
			await review(d.context, slide)

			const frame = (d.session.deck.nodes.get(slide)?.shapes ?? []).find(shape => shape.frame?.kind === "smartart") as ShapeNode
			const info = (await smartartCapability.info(d.session, { slide, id: frame.id })) as SmartArtInfo

			expect(info.nodes.length).toBeGreaterThan(0)
		}
	)
})
