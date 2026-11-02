import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { danglingReferences, partsOf } from "./pptxWriteFixtures"

// A diagram edit undone on a slide that an undo restored from the parts its delete held, with no save in between:
// the held diagram parts are the frame's (the package lost them with the save after the delete), so the undo reads
// them there and the history goes on to the start; the file written then relates every part it names.

const PIE = join(CORPUS_DIR, "pptx", "lo__tdf149551_SmartArt_Pie.pptx")

function frameIn(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") return shape

		const child = shape.children === undefined ? undefined : frameIn(shape.children)

		if (child !== undefined) return child
	}

	return undefined
}

async function opened(bytes: Uint8Array) {
	const d = await driveSession(bytes, "pptx")

	smartArtRenderer(d.session, {
		services: {
			xml: part => pptxParts(d.session.deck)?.document(part),
			relationship: () => undefined,
			contentType: () => undefined
		}
	})

	for (const slide of d.session.deck.slides) {
		await review(d.context, slide)

		const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes)

		if (frame !== undefined) return { d, slide, frame }
	}

	throw new Error("no diagram")
}

async function written(d: Awaited<ReturnType<typeof driveSession>>): Promise<Uint8Array> {
	const saved = await d.save()

	expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

	if (saved.bytes === undefined) throw new Error("not saved")

	expect(await danglingReferences(saved.bytes)).toEqual([])

	return saved.bytes
}

describe.skipIf(!existsSync(PIE))("a diagram edit undone on a slide restored from held parts", () => {
	it("undoes to the start with no save between, and the file written is the source's diagram again", async () => {
		const source = new Uint8Array(readFileSync(PIE))
		const { d, slide, frame } = await opened(source)
		const def = { uniqueId: "urn:filen:smartart:layout:venn", source: "gallery" } as const

		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
		expect((await d.command({ family: "smartart", kind: "setLayout", target: { slide, id: frame.id }, def })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "delete", slides: [d.session.deck.slides[1] as SlideRef] })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
		await written(d)

		// Every step back to the opened file, the diagram edit on the restored slide included.
		for (let step = 0; step < 5; step++) expect((await d.undo()).ok, `undo ${String(step + 1)}`).toBe(true)

		const bytes = await written(d)
		const restored = (await partsOf(bytes)).keys()
		const diagrams = [...restored].filter(name => name.startsWith("/ppt/diagrams/") || name.startsWith("ppt/diagrams/"))

		// One slide with the source's layout again (no Venn definition anywhere).
		expect(d.session.deck.slides).toHaveLength(1)
		expect(diagrams.length).toBeGreaterThan(0)

		const text = new TextDecoder()
		const all = await partsOf(bytes)

		for (const name of diagrams) expect(text.decode(all.get(name)), name).not.toContain("urn:filen:smartart:layout:venn")

		// And redo goes forward again through all of it.
		for (let step = 0; step < 5; step++) expect((await d.redo()).ok, `redo ${String(step + 1)}`).toBe(true)

		await written(d)
	})
	it("a copy deleted before any save comes back after the save that dropped its diagram's parts: each undo writes", async () => {
		const { d, slide, frame } = await opened(new Uint8Array(readFileSync(PIE)))
		const def = { uniqueId: "urn:filen:smartart:layout:venn", source: "gallery" } as const

		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
		expect((await d.command({ family: "smartart", kind: "setLayout", target: { slide, id: frame.id }, def })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "delete", slides: [d.session.deck.slides[1] as SlideRef] })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
		await written(d)

		// The third undo brings back the copy, made by an op and deleted unsaved: its frame names the source's
		// diagram parts, which left the package with the first save.
		for (let step = 0; step < 5; step++) {
			expect((await d.undo()).ok, `undo ${String(step + 1)}`).toBe(true)
			await written(d)
		}

		expect(d.session.deck.slides).toHaveLength(1)
	})
	for (const name of ["lo__tdf149551_SmartArt_Pie.pptx", "lo__smartart-org-chart.pptx", "lo__smartart-picture-strip.pptx"]) {
		const path = join(CORPUS_DIR, "pptx", name)

		for (const viaDuplicate of [false, true])
			it.skipIf(!existsSync(path))(
				`${name}: restored after a save, its colours changed and undone with saves between, every later save writes${viaDuplicate ? " (its duplicate kept)" : ""}`,
				async () => {
					const { d, slide, frame } = await opened(new Uint8Array(readFileSync(path)))
					const node = d.session.deck.nodes.get(slide) as SlideNode

					if (viaDuplicate) expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
					else if (node.parent !== undefined)
						expect((await d.command({ family: "slide", kind: "add", layout: node.parent, at: 1 })).ok).toBe(true)

					expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
					await written(d)
					expect((await d.undo()).ok).toBe(true)
					expect(
						(
							await d.command({
								family: "smartart",
								kind: "setColors",
								target: { slide, id: frame.id },
								def: { uniqueId: "urn:filen:smartart:colors:colorful", source: "gallery" }
							})
						).ok
					).toBe(true)
					await written(d)
					expect((await d.undo()).ok).toBe(true)
					await written(d)

					const last = d.session.deck.slides[d.session.deck.slides.length - 1] as SlideRef

					expect((await d.command({ family: "slide", kind: "hide", slides: [last], hidden: true })).ok).toBe(true)
					await written(d)
				}
			)
	}
})
