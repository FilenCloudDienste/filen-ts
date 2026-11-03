import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { chartEditOp, insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import { slideSizeOp } from "../core/presentation/edit/commands/design"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { chartCapability } from "../dom/presentation/engine/chart"
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
const SOURCE_CHART = join(CORPUS_DIR, "pptx", "docx4j__loadAndSave.pptx")

// Every entry whose bytes differ between two packages, or that only one has.
async function differing(a: Uint8Array, b: Uint8Array): Promise<string[]> {
	const read = async (bytes: Uint8Array): Promise<Map<string, string>> => {
		const zip = await ZipArchive.open(bytesSource(bytes))
		const out = new Map<string, string>()

		for (const entry of zip.entries) out.set(entry.name, Buffer.from(await zip.read(entry)).toString("base64"))

		return out
	}
	const left = await read(a)
	const right = await read(b)

	return [...new Set([...left.keys(), ...right.keys()])].filter(name => left.get(name) !== right.get(name))
}

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
	for (const edit of ["title", "move"] as const)
		it(`pptx: a chart inserted and saved, its slide deleted and saved, the delete undone, the chart edited (${edit}): every save written`, async () => {
			const d = await reopened(
				buildPptx({
					slides: [0, 1].map(at => ({
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
					}))
				}),
				"pptx"
			)
			const slide = d.session.deck.slides[1] as SlideRef

			await command(
				d,
				insertChartOp(d.session.deck, slide, 0, "column", sampleChartCells({ categories: ["A", "B"], series: ["N"] })) as DeckOp
			)
			await saved(d)
			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await saved(d)
			expect((await d.undo()).ok).toBe(true)
			await review(d.context, slide)

			const chart = (d.session.deck.nodes.get(slide)?.shapes ?? []).find(shape => shape.frame?.kind === "chart") as ShapeNode

			await command(
				d,
				edit === "title"
					? chartEditOp({ slide, id: chart.id }, { kind: "title", text: "T" })
					: {
							family: "shape",
							kind: "setXfrm",
							target: { slide, id: chart.id },
							xfrm: { ...(chart.xfrm as Xfrm), x: (chart.xfrm as Xfrm).x + 12_700 }
						}
			)
			await saved(d)
			await command(d, { family: "slide", kind: "hide", slides: [d.session.deck.slides[0] as SlideRef], hidden: true })
			await saved(d)
			await undoAll(d)
			await saved(d)
		})

	it.skipIf(!existsSync(SOURCE_CHART))(
		"pptx: a source chart's slide deleted and saved, the delete undone, the chart's title edited: every save written",
		async () => {
			const d = await reopened(new Uint8Array(readFileSync(SOURCE_CHART)), "pptx")
			let slide: SlideRef | undefined

			for (const ref of d.session.deck.slides) {
				await review(d.context, ref)
				if ((d.session.deck.nodes.get(ref)?.shapes ?? []).some(shape => shape.frame?.kind === "chart")) slide = ref
			}

			expect(slide).toBeDefined()

			const at = slide as SlideRef

			await command(d, { family: "slide", kind: "delete", slides: [at] })
			await saved(d)
			expect((await d.undo()).ok).toBe(true)
			await review(d.context, at)

			const chart = (d.session.deck.nodes.get(at)?.shapes ?? []).find(shape => shape.frame?.kind === "chart") as ShapeNode

			expect((await chartCapability.chartData(d.context, { slide: at, id: chart.id }, { workbook: true })).info).not.toBeNull()
			await command(d, chartEditOp({ slide: at, id: chart.id }, { kind: "title", text: "T" }))
			await saved(d)
			await command(d, {
				family: "slide",
				kind: "hide",
				slides: [d.session.deck.slides.find(ref => ref !== at) as SlideRef],
				hidden: true
			})
			await saved(d)
		}
	)
})

describe("undo across a save is byte for byte", () => {
	// A tree with whitespace between its elements and no shapes, and a default text style the size scales.
	const spaced = (): Uint8Array =>
		buildPptx({
			slides: [
				{ shapes: "\n" },
				{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("S"))) }
			]
		})
	const ops = {
		"a shape inserted into an empty tree": (d: Drive): DeckOp => ({
			family: "shape",
			kind: "insert",
			slide: d.session.deck.slides[0] as SlideRef,
			shape: {
				id: 5,
				name: "Box",
				hidden: false,
				kind: "sp",
				xfrm: BOX,
				props: { geometry: { kind: "preset", preset: "rect", guides: [] } }
			} as ShapeNode
		}),
		"the slide size": (d: Drive): DeckOp =>
			slideSizeOp({ cx: d.session.deck.size.cx === 12_192_000 ? 9_144_000 : 12_192_000, cy: 6_858_000 }, "ensureFit") as DeckOp
	} satisfies Record<string, (d: Drive) => DeckOp>

	const corpus = (name: string) => (): Uint8Array | undefined => {
		const path = join(CORPUS_DIR, "pptx", `${name}.pptx`)

		return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined
	}
	const cases: readonly (readonly [string, () => Uint8Array | undefined, keyof typeof ops])[] = [
		["synthetic", spaced, "a shape inserted into an empty tree"],
		["lo__animation-sound-embedded", corpus("lo__animation-sound-embedded"), "a shape inserted into an empty tree"],
		["oxpt__TestPresentation", corpus("oxpt__TestPresentation"), "the slide size"],
		["lo__tdf149551_SmartArt_Pie", corpus("lo__tdf149551_SmartArt_Pie"), "the slide size"]
	]

	for (const [deck, bytes, name] of cases)
		it(`pptx ${deck}: ${name}, saved and undone: the next save writes the source's bytes`, async () => {
			const source = bytes()

			if (source === undefined) return

			const d = await reopened(source, "pptx")

			await review(d.context, d.session.deck.slides[0] as SlideRef)
			await command(d, ops[name](d))
			await saved(d)
			expect((await d.undo()).ok).toBe(true)

			const undone = await d.save()

			expect(undone.result.kind).toBe("written")
			expect(await differing(source, undone.bytes as Uint8Array)).toEqual([])
		})
})
