import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { chartEditOp, insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { viewCapability } from "../dom/presentation/engine/view"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// A slide holding a chart from the file (its object a directory of the package), duplicated and saved before either
// chart is edited: the copy's frame names an object of its own (Object N, a name no package of the session had), so
// editing one chart after a reopen leaves the other as it was.

type Drive = Awaited<ReturnType<typeof driveSession>>

const CELLS = sampleChartCells({ categories: ["A", "B", "C"], series: ["North", "South"] })

async function chartDeck(): Promise<Uint8Array> {
	const d = await driveSession(odpBytes({ body: '<draw:page draw:name="One" draw:master-page-name="M"></draw:page>' }), "odp")

	expect((await d.command(insertChartOp(d.session.deck, d.session.deck.slides[0] as SlideRef, 0, "column", CELLS))).ok).toBe(true)

	return written(d)
}

async function written(d: Drive): Promise<Uint8Array> {
	const outcome = await d.save()

	if (outcome.result.kind !== "written" || outcome.bytes === undefined) throw new Error(JSON.stringify(outcome.result))

	return outcome.bytes
}

async function chartOf(d: Drive, slide: SlideRef): Promise<ShapeNode> {
	await viewCapability.render(d.context, [slide])

	const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.frame?.kind === "chart")

	if (shape === undefined) throw new Error("no chart")

	return shape
}

// Each page's chart object directory, as its frame names it.
function objectsOf(bytes: Uint8Array): string[] {
	const content = strFromU8(unzipSync(bytes)["content.xml"] as Uint8Array)

	return [...content.matchAll(/<draw:object [^>]*xlink:href="\.\/([^"]+)"/gu)].map(match => match[1] ?? "")
}

function titleIn(bytes: Uint8Array, object: string): string {
	const xml = strFromU8(unzipSync(bytes)[`${object}/content.xml`] as Uint8Array)

	return xml.includes("Retitled") ? "Retitled" : "base"
}

describe("a file's chart on a duplicated slide, saved before either chart is edited", () => {
	it("writes the copy's frame naming an object of its own, so an edit of one chart after a reopen leaves the other", async () => {
		const source = await chartDeck()
		const d = await driveSession(source, "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await chartOf(d, first)
		expect((await d.command({ family: "slide", kind: "duplicate", slide: first })).ok).toBe(true)

		const saved = await written(d)
		const objects = objectsOf(saved)
		const entries = Object.keys(unzipSync(saved))

		expect(objects).toHaveLength(2)
		expect(new Set(objects).size).toBe(2)
		for (const object of objects) expect(entries).toContain(`${object}/content.xml`)

		const manifest = strFromU8(unzipSync(saved)["META-INF/manifest.xml"] as Uint8Array)

		for (const object of objects) expect(manifest).toContain(`manifest:full-path="${object}/"`)

		const reopened = await driveSession(saved, "odp")
		const slide = reopened.session.deck.slides[0] as SlideRef
		const chart = await chartOf(reopened, slide)

		expect((await reopened.command(chartEditOp({ slide, id: chart.id }, { kind: "title", text: "Retitled" }))).ok).toBe(true)

		const edited = await written(reopened)
		const after = objectsOf(edited)

		expect(after.map(object => titleIn(edited, object))).toEqual(["Retitled", "base"])
	})

	it("writes the same bytes for the duplicate saved again after an undo and a redo", async () => {
		const d = await driveSession(await chartDeck(), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await chartOf(d, first)
		expect((await d.command({ family: "slide", kind: "duplicate", slide: first })).ok).toBe(true)

		const once = await written(d)

		expect((await d.undo()).ok).toBe(true)
		await written(d)
		expect((await d.redo()).ok).toBe(true)

		const again = await written(d)

		expect(Buffer.from(again).equals(Buffer.from(once))).toBe(true)
	})
})
