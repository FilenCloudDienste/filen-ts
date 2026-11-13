import { describe, expect, it } from "vitest"
import type { Paragraph, TextBody } from "../core/presentation/model"
import { renderSlide } from "../core/presentation/render/slide"
import { layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import { openInfo } from "../dom/presentation/engine"
import { savePortAnnounced, savePortReader, savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import { LAYOUT, SLIDE, deckOf, renderServices } from "./fixtures/presentation/renderDeck"
import { editDeck, editHarness } from "./presentationEditFixtures"
import { FakeMeasurer, testFont } from "./textFixtures"

// What the editor page reads of the session: whether a step can be undone, the deck's layouts and a slide's layout,
// the slide list after a hide or a section change, run offsets of a laid-out body, and whether a save will write
// before any upload opens.

function changes(events: readonly { readonly type: string }[]) {
	return events.filter(event => event.type === "changed") as Extract<
		Awaited<ReturnType<typeof editHarness>>["events"][number],
		{ type: "changed" }
	>[]
}

describe("presentation editor seams", () => {
	it("the changed event says whether a step can be undone or redone", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)

		expect(
			await harness.command({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: 4 }, alt: { descr: "x" } })
		).toMatchObject({
			ok: true
		})
		expect(changes(harness.events).at(-1)).toMatchObject({ canUndo: true, canRedo: false })
		await harness.undo()
		expect(changes(harness.events).at(-1)).toMatchObject({ canUndo: false, canRedo: true })
		harness.close()
	})

	it("re-sends the slide list when a slide is hidden and the sections when they change", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(1)

		await harness.command({ family: "slide", kind: "hide", slides: [slide.ref], hidden: true })
		expect(
			changes(harness.events)
				.at(-1)
				?.info?.slides?.find(entry => entry.ref === slide.ref)
		).toEqual({ ref: slide.ref, hidden: true })

		const sections = [{ name: "All", id: "{33333333-3333-3333-3333-333333333333}", slides: [...harness.session.deck.slides] }]

		await harness.command({ family: "slide", kind: "setSections", sections })
		expect(
			changes(harness.events)
				.at(-1)
				?.info?.sections?.map(section => section.name)
		).toEqual(["All"])
		harness.close()
	})

	it("lists the layouts with their master, type and name in OpenInfo", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const info = openInfo(deck, harness.session.package)

		expect(info.layouts?.map(layout => [layout.type, layout.name])).toEqual([
			["obj", "Title and Content"],
			["blank", "Blank"]
		])

		for (const layout of info.layouts ?? []) expect(layout.master).toBe(deck.nodes.get(layout.ref)?.parent)

		harness.close()
	})

	it("names the slide's layout in its render", async () => {
		const fixture = renderServices({ parts: {} })
		const deck = deckOf([], [], [])
		const render = await renderSlide(deck, SLIDE, fixture.services, { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 })

		expect(render.layout).toBe(LAYOUT)
	})

	it("transfers each model run's end offset, the marker length and the fonts' kerning with a body's layout", () => {
		const env: TextEnvironment = {
			fonts: { resolve: request => ({ ...testFont(), weight: request.bold ? 700 : 400, italic: request.italic }) },
			cache: new MeasureCache(new FakeMeasurer())
		}
		const pPr = { marL: 342900, indent: -342900, bullet: { kind: "char" as const, char: "•" } }
		const paragraphs: Paragraph[] = [
			{
				pPr,
				runs: [
					{ kind: "fld", type: "slidenum", id: "{00000000-0000-0000-0000-000000000001}", text: "‹#›", rPr: { sz: 1200 } },
					{ kind: "r", text: "x", rPr: { sz: 1200 } }
				]
			},
			{
				pPr: {},
				runs: [
					{ kind: "r", text: "ab", rPr: { sz: 1200 } },
					{ kind: "br", rPr: {} },
					{ kind: "r", text: "", rPr: {} }
				]
			}
		]
		const text: TextBody = { bodyPr: {}, paragraphs }
		const context: BodyContext = { listStyles: [], bodyPr: [], fonts: { color: () => undefined, typeface: typeface => typeface } }
		const result = layoutBody(resolveBody(text, context), { width: 400, height: 300 }, env, { fields: { slideNumber: 12 } })
		const layout = transferableLayout(result)
		const prefix = layout.prefixes?.[0] ?? -1

		expect(prefix).toBe(2)
		expect(layout.texts[0]).toBe("•\t12x")
		expect([...(layout.runStarts ?? [])]).toEqual([0, 2, 5])
		// The field displays two characters where it stores three.
		expect([...(layout.runEnds ?? [])].slice(0, 2)).toEqual([prefix + 2, prefix + 3])
		// A line break and an empty run each end where the text before them does.
		expect([...(layout.runEnds ?? [])].slice(2)).toEqual([2, 3, 3])
		expect(layout.kerning).toHaveLength(layout.fonts.length)
		expect([...(layout.kerning ?? [])].every(flag => flag === 0 || flag === 1)).toBe(true)
		// Own copies: transferring the layout leaves the body's arrays attached.
		expect(layout.runEnds).not.toBe(result.runEnds)
	})

	it("tells the page before any upload whether the writer will write", async () => {
		const unchanged = new MessageChannel()
		const announcedUnchanged = savePortAnnounced(unchanged.port2 as unknown as SavePortEnd)

		savePortWriter(unchanged.port1 as unknown as SavePortEnd).abort("unchanged")
		expect(await announcedUnchanged).toBe(false)

		const writing = new MessageChannel()
		const announced = savePortAnnounced(writing.port2 as unknown as SavePortEnd)
		const writer = savePortWriter(writing.port1 as unknown as SavePortEnd)

		writer.announce()
		expect(await announced).toBe(true)

		// The port goes on to the upload: a reader on it pulls and receives what the writer writes.
		const reader = savePortReader(writing.port2 as unknown as SavePortEnd)
		const written = (async () => {
			await writer.write(new Uint8Array([1, 2, 3]))
			await writer.close()
			writer.commit()
		})()

		expect(await reader.read()).toEqual(new Uint8Array([1, 2, 3]))
		expect(await reader.read()).toBeUndefined()
		await written
		reader.settled(true)
		expect(await writer.uploaded).toBe(true)
	})
})
