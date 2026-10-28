import { unzipSync, strFromU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { chartEditOp, insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { viewCapability } from "../dom/presentation/engine/view"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A chart the package already holds, on a slide that is duplicated: each frame's chart is its own from the start. An
// edit of either frame's chart never reaches the other's, whether the duplicate was saved before the edit or not, and
// across undo and redo past saves.

type Format = "pptx" | "odp"
type Drive = Awaited<ReturnType<typeof driveSession>>

const CELLS = sampleChartCells({ categories: ["A", "B", "C"], series: ["North", "South"] })

function blank(format: Format): Uint8Array {
	return format === "odp"
		? odpBytes({ body: '<draw:page draw:name="One" draw:master-page-name="M"></draw:page>' })
		: buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("x"))) }] })
}

// A file whose first slide holds a chart of the package (inserted and saved in another session).
async function withPackageChart(format: Format): Promise<Uint8Array> {
	const d = await driveSession(blank(format), format)
	const slide = d.session.deck.slides[0] as SlideRef

	expect(await d.command(insertChartOp(d.session.deck, slide, 0, "column", CELLS))).toMatchObject({ ok: true })

	return (await d.save()).bytes as Uint8Array
}

function chartShape(d: Drive, slide: SlideRef): ShapeNode {
	return (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.frame?.kind === "chart") as ShapeNode
}

async function saved(d: Drive): Promise<Uint8Array> {
	const out = await d.save()

	expect(out.result).toMatchObject({ kind: "written" })

	return out.bytes as Uint8Array
}

// For each slide of a saved file in order, whether the chart its frame names holds `text`; and the chart parts or
// objects the file holds.
async function titles(bytes: Uint8Array, format: Format, text: string): Promise<{ readonly slides: boolean[]; readonly charts: number }> {
	const d = await driveSession(bytes, format)
	const files = unzipSync(bytes)
	const slides: boolean[] = []

	for (const slide of d.session.deck.slides) {
		await viewCapability.render(d.context, [slide])

		const part = (chartShape(d, slide).frame as { readonly part: string }).part
		const name = format === "pptx" ? part.slice(1) : `${part.slice(1, part.lastIndexOf("/"))}/content.xml`

		slides.push(strFromU8(files[name] as Uint8Array).includes(text))
	}

	const charts = Object.keys(files).filter(name =>
		format === "pptx" ? /^ppt\/charts\/chart\d+\.xml$/u.test(name) : /^Object \d+\/content\.xml$/u.test(name)
	).length

	return { slides, charts }
}

async function duplicated(
	format: Format,
	saveBetween: boolean
): Promise<{ readonly d: Drive; readonly slide: SlideRef; readonly copy: SlideRef }> {
	const d = await driveSession(await withPackageChart(format), format)
	const slide = d.session.deck.slides[0] as SlideRef

	await viewCapability.render(d.context, [slide])
	expect(await d.command({ family: "slide", kind: "duplicate", slide })).toMatchObject({ ok: true })

	if (saveBetween) await saved(d)

	const copy = d.session.deck.slides[1] as SlideRef

	await viewCapability.render(d.context, [copy])

	return { d, slide, copy }
}

async function retitle(d: Drive, slide: SlideRef, text: string): Promise<void> {
	expect(await d.command(chartEditOp({ slide, id: chartShape(d, slide).id }, { kind: "title", text }))).toMatchObject({ ok: true })
}

describe("a duplicated slide's chart is its own", () => {
	for (const format of ["pptx", "odp"] as const)
		for (const saveBetween of [false, true])
			it(`${format}: the copy's chart edit is saved into the copy's chart only (${saveBetween ? "saved before the edit" : "same save"})`, async () => {
				const { d, copy } = await duplicated(format, saveBetween)

				await retitle(d, copy, "COPY")

				const after = await titles(await saved(d), format, "COPY")

				expect(after.slides).toEqual([false, true])
				// One chart per frame: the copy's edit adds none beside the one the duplicate has.
				expect(after.charts).toBe(2)
			})

	for (const format of ["pptx", "odp"] as const)
		it(`${format}: undo and redo of the copy's chart edit across saves never touch the original's chart`, async () => {
			const { d, slide, copy } = await duplicated(format, false)

			await retitle(d, copy, "COPY")
			expect((await titles(await saved(d), format, "COPY")).slides).toEqual([false, true])

			expect((await d.undo()).ok).toBe(true)
			expect((await titles(await saved(d), format, "COPY")).slides).toEqual([false, false])

			expect((await d.redo()).ok).toBe(true)

			const redone = await titles(await saved(d), format, "COPY")

			expect(redone.slides).toEqual([false, true])
			expect(redone.charts).toBe(2)

			// The original's own edit afterwards lands in the original's chart alone.
			await retitle(d, slide, "ORIGINAL")
			expect((await titles(await saved(d), format, "ORIGINAL")).slides).toEqual([true, false])
			expect((await titles(d.drive.files.get(d.drive.current) as Uint8Array, format, "COPY")).slides).toEqual([false, true])
		})

	for (const format of ["pptx", "odp"] as const)
		it(`${format}: the original's chart edited first stays the original's, the copy keeps the source's chart`, async () => {
			const { d, slide, copy } = await duplicated(format, false)

			await retitle(d, slide, "ORIGINAL")
			await retitle(d, copy, "COPY")

			const bytes = await saved(d)

			expect((await titles(bytes, format, "ORIGINAL")).slides).toEqual([true, false])
			expect((await titles(bytes, format, "COPY")).slides).toEqual([false, true])
		})
})
