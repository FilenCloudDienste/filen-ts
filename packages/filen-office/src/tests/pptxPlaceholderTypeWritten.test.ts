import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { zipParts } from "../core/templates/zip"
import { designDeckParts } from "./presentationDesignFixtures"
import { partsOf } from "./pptxWriteFixtures"

// A content placeholder written <p:ph type="obj" idx="1"/> (the default type spelled out, as a .ppt's Save-as copy and
// other producers write it) is edited like any placeholder: its text and the deck's slide size change, and the save
// writes the type as the source had it.

// A Title and Content slide whose content placeholder spells the type out.
async function deck(spelled = true): Promise<Uint8Array> {
	const parts = designDeckParts(["obj"]).map(([name, markup]): [string, string] =>
		name === "ppt/slides/slide1.xml" && spelled
			? [name, markup.replace('<p:ph idx="1"/>', '<p:ph type="obj" idx="1"/>')]
			: [name, markup]
	)

	expect(parts.find(([name]) => name === "ppt/slides/slide1.xml")?.[1]).toContain(
		spelled ? '<p:ph type="obj" idx="1"/>' : '<p:ph idx="1"/>'
	)

	return zipParts(parts)
}

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

describe('a placeholder written type="obj"', () => {
	it("takes a text edit and a slide size change, and is saved with its type as written", async () => {
		const d = await driveSession(await deck(), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.ph?.idx === 1)

		expect(shape?.lock).toBeUndefined()
		expect(
			await d.command({ family: "text", kind: "setText", target: { slide, id: shape?.id ?? 0 }, body: plain("Edited") } as DeckOp)
		).toMatchObject({ ok: true })
		expect(
			await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" } as DeckOp)
		).toMatchObject({ ok: true })

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const xml = new TextDecoder().decode((await partsOf(saved.bytes as Uint8Array)).get("ppt/slides/slide1.xml"))

		expect(xml).toContain('<p:ph type="obj" idx="1"/>')
		expect(xml).toContain("Edited")
	})

	it("keeps an omitted type omitted", async () => {
		const d = await driveSession(await deck(false), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.ph?.idx === 1)

		expect(shape?.lock).toBeUndefined()
		expect(shape?.ph?.typeWritten).toBeUndefined()
		expect(
			await d.command({ family: "text", kind: "setText", target: { slide, id: shape?.id ?? 0 }, body: plain("Edited") } as DeckOp)
		).toMatchObject({ ok: true })

		const saved = await d.save()
		const xml = new TextDecoder().decode((await partsOf(saved.bytes as Uint8Array)).get("ppt/slides/slide1.xml"))

		expect(xml).toContain('<p:ph idx="1"/>')
		expect(xml).not.toContain('type="obj"')
	})
})
