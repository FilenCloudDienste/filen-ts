import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { ShapeNode, ShapePropsEdit, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile, reopened } from "./modelVsFile"
import { driveSession } from "./odpWriteDrive"

// A fill, line or shadow given to an empty ODP presentation object (presentation:placeholder="true", a prompt nothing
// draws) makes it a drawn object: the save writes it without the placeholder flag and with every graphic property the
// model shows, so the file reads back as the session, and the slide's other edits stay.

const RED = { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } as const
const typed = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })
const has = (name: string): boolean => existsSync(join(CORPUS_DIR, "odp", name))

async function opened(name: string) {
	const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", name))), "odp")
	const slide = d.session.deck.slides[0] as SlideRef

	await review(d.context, slide)

	return { d, slide, shapes: d.session.deck.nodes.get(slide)?.shapes ?? [] }
}

const empty = (shape: ShapeNode): boolean =>
	shape.ph !== undefined && !(shape.text?.paragraphs.some(paragraph => paragraph.runs.length > 0) ?? false) && shape.kind === "sp"

describe("a graphic property given to an empty ODP placeholder", () => {
	for (const [name, props] of [
		["lo__tdf156955.odp", { fill: RED }],
		["lo__tdf156955.odp", { ln: { w: 25_400, fill: RED } }],
		["lo__media_embedding.odp", { fill: RED }]
	] as const)
		it.runIf(has(name))(
			`${name} ${Object.keys(props).join()}: written, read back, the flag dropped`,
			{ timeout: 120_000 },
			async () => {
				const { d, slide, shapes } = await opened(name)
				const target = shapes.find(empty) as ShapeNode
				const other = shapes.find(shape => shape !== target && shape.ph !== undefined && shape.kind === "sp")

				if (other !== undefined)
					expect(
						(await d.command({ family: "text", kind: "setText", target: { slide, id: other.id }, body: typed("My title") })).ok
					).toBe(true)
				expect(
					(
						await d.command({
							family: "shape",
							kind: "setProps",
							target: { slide, id: target.id },
							props: props as ShapePropsEdit
						})
					).ok
				).toBe(true)

				const saved = await d.save()

				expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))
				expect(await modelVsFile(d, saved.bytes as Uint8Array, "odp")).toBe("")

				const content = strFromU8(
					unzipSync(saved.bytes as Uint8Array, { filter: file => file.name === "content.xml" })["content.xml"] as Uint8Array
				)

				if (other !== undefined) expect(content).toContain("My title")

				const again = await reopened(saved.bytes as Uint8Array, "odp")
				const first = again.session.deck.slides[0] as SlideRef

				await review(again.context, first)

				const read = again.session.deck.nodes
					.get(first)
					?.shapes.find(shape => shape.name === target.name && shape.ph?.type === target.ph?.type)

				for (const [key, value] of Object.entries(props))
					expect((read?.props as Record<string, unknown> | undefined)?.[key]).toMatchObject(value)
			}
		)

	it.runIf(has("lo__tdf156955.odp"))(
		"filled, then the fill taken off again: the flag comes back and the file reads as the session",
		{ timeout: 120_000 },
		async () => {
			const { d, slide, shapes } = await opened("lo__tdf156955.odp")
			const target = shapes.find(empty) as ShapeNode

			expect(
				(await d.command({ family: "shape", kind: "setProps", target: { slide, id: target.id }, props: { fill: RED } })).ok
			).toBe(true)
			expect((await d.save()).result).toEqual(expect.objectContaining({ kind: "written" }))
			expect(
				(await d.command({ family: "shape", kind: "setProps", target: { slide, id: target.id }, props: { fill: "none" } })).ok
			).toBe(true)

			const saved = await d.save()

			expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))
			expect(await modelVsFile(d, saved.bytes as Uint8Array, "odp")).toBe("")
		}
	)
})
