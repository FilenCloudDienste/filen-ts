import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences, partsOf } from "./pptxWriteFixtures"

// A diagram's layout, style or colours changed and saved (its data and drawing rewritten in their parts), then undone:
// the next save gives every part back byte for byte.

type Drive = Awaited<ReturnType<typeof driveSession>>
type Change = "setLayout" | "setStyle" | "setColors"

const BOX: Xfrm = {
	x: 1_000_000,
	y: 1_000_000,
	cx: 6_000_000,
	cy: 3_000_000,
	rot: 0,
	flipH: false,
	flipV: false
}
const CHANGES: Readonly<Record<Change, string>> = {
	setLayout: "urn:filen:smartart:layout:process-basic",
	setStyle: "urn:filen:smartart:style:moderate",
	setColors: "urn:filen:smartart:colors:colorful"
}
const DECKS = ["lo__tdf149551_SmartArt_Pie.pptx", "lo__smartart-children.pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx"]

function frameIn(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") return shape

		const child = shape.children === undefined ? undefined : frameIn(shape.children)

		if (child !== undefined) return child
	}

	return undefined
}

function render(d: Drive): void {
	smartArtRenderer(d.session, {
		services: {
			xml: part => pptxParts(d.session.deck)?.document(part),
			relationship: () => undefined,
			contentType: () => undefined
		}
	})
}

async function firstDiagram(d: Drive): Promise<{ slide: SlideRef; id: number }> {
	for (const slide of d.session.deck.slides) {
		await review(d.context, slide)

		const node = d.session.deck.nodes.get(slide) as SlideNode | undefined
		const frame = node === undefined ? undefined : frameIn(node.shapes)

		if (frame !== undefined) return { slide, id: frame.id }
	}

	throw new Error("no diagram")
}

function change(kind: Change, target: { slide: SlideRef; id: number }): DeckOp {
	return {
		family: "smartart",
		kind,
		target,
		def: { uniqueId: CHANGES[kind], source: "gallery" }
	} as DeckOp
}

async function written(d: Drive): Promise<Uint8Array> {
	const result = await d.save()

	expect(result.result.kind).toBe("written")

	if (result.bytes === undefined) throw new Error("not saved")

	expect(await danglingReferences(result.bytes)).toEqual([])

	return result.bytes
}

// The parts whose bytes differ.
async function differing(a: Uint8Array, b: Uint8Array): Promise<string[]> {
	const left = await partsOf(a)
	const right = await partsOf(b)
	const same = (x: Uint8Array | undefined, y: Uint8Array | undefined): boolean =>
		x !== undefined && y !== undefined && x.length === y.length && x.every((byte, at) => byte === y[at])

	return [...new Set([...left.keys(), ...right.keys()])].filter(name => !same(left.get(name), right.get(name))).sort()
}

async function undoneAfterSave(d: Drive, target: { slide: SlideRef; id: number }, kind: Change): Promise<Uint8Array> {
	expect((await d.command(change(kind, target))).ok).toBe(true)
	await written(d)
	expect((await d.undo()).ok).toBe(true)

	return written(d)
}

describe("a diagram's layout, style or colours undone after a save", () => {
	for (const kind of Object.keys(CHANGES) as Change[])
		it(`${kind}: a diagram the session wrote is written back as its first save had it`, async () => {
			const d = await driveSession(
				buildPptx({
					slides: [
						{
							shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P")))
						}
					]
				}),
				"pptx"
			)
			const slide = d.session.deck.slides[0] as SlideRef

			render(d)
			expect(
				(
					await d.command({
						family: "smartart",
						kind: "insert",
						slide,
						shape: {
							id: 0,
							name: "Diagram",
							hidden: false,
							kind: "frame",
							xfrm: BOX
						} as ShapeNode,
						layout: {
							uniqueId: "urn:filen:smartart:layout:list-basic",
							source: "gallery"
						},
						texts: ["Alpha", "Beta", "Gamma"]
					})
				).ok
			).toBe(true)

			const first = await written(d)
			const id = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.name === "Diagram")?.id ?? 0

			expect(await differing(first, await undoneAfterSave(d, { slide, id }, kind))).toEqual([])
		})

	it("setLayout: undone, redone and undone again across saves, written back as the first save had it each time", async () => {
		const d = await driveSession(
			buildPptx({
				slides: [
					{
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P")))
					}
				]
			}),
			"pptx"
		)
		const slide = d.session.deck.slides[0] as SlideRef

		render(d)
		expect(
			(
				await d.command({
					family: "smartart",
					kind: "insert",
					slide,
					shape: {
						id: 0,
						name: "Diagram",
						hidden: false,
						kind: "frame",
						xfrm: BOX
					} as ShapeNode,
					layout: {
						uniqueId: "urn:filen:smartart:layout:list-basic",
						source: "gallery"
					},
					texts: ["Alpha", "Beta", "Gamma"]
				})
			).ok
		).toBe(true)

		const first = await written(d)
		const id = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.name === "Diagram")?.id ?? 0

		expect(await differing(first, await undoneAfterSave(d, { slide, id }, "setLayout"))).toEqual([])
		expect((await d.redo()).ok).toBe(true)
		await written(d)
		expect((await d.undo()).ok).toBe(true)
		expect(await differing(first, await written(d))).toEqual([])
	})

	for (const file of DECKS) {
		const path = join(CORPUS_DIR, "pptx", file)

		for (const kind of Object.keys(CHANGES) as Change[])
			it.skipIf(!existsSync(path))(`${kind}: ${file} is written back byte for byte`, { timeout: 120_000 }, async () => {
				const source = new Uint8Array(readFileSync(path))
				const d = await driveSession(source, "pptx")

				render(d)

				expect(await differing(source, await undoneAfterSave(d, await firstDiagram(d), kind))).toEqual([])
			})
	}

	for (const file of ["lo__smartart-children.pptx", "lo__tdf149551_SmartArt_Pie.pptx"]) {
		const path = join(CORPUS_DIR, "pptx", file)

		it.skipIf(!existsSync(path))(
			`layout, style and colours each saved, then undone one at a time with saves: ${file} is each saved state again`,
			{
				timeout: 120_000
			},
			async () => {
				const source = new Uint8Array(readFileSync(path))
				const d = await driveSession(source, "pptx")

				render(d)

				const target = await firstDiagram(d)
				const states: Uint8Array[] = [source]

				for (const kind of Object.keys(CHANGES) as Change[]) {
					expect((await d.command(change(kind, target))).ok).toBe(true)
					states.push(await written(d))
				}

				for (let at = states.length - 2; at >= 0; at--) {
					expect((await d.undo()).ok).toBe(true)
					expect(await differing(states[at] ?? source, await written(d))).toEqual([])
				}
			}
		)
	}
})
