import { describe, expect, it } from "vitest"
import type { SlideRef, Xfrm } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// A box written in another unit than the writer's (inches here) keeps the text the file has for each length that
// reads back as the same EMU: a frame moved sideways rewrites svg:x alone (in the writer's cm).

const FRAMES =
	'<draw:frame draw:name="Inches" svg:x="1in" svg:y="2in" svg:width="3in" svg:height="1in"><draw:text-box><text:p>a</text:p></draw:text-box></draw:frame>' +
	'<draw:frame draw:name="Title" presentation:class="title" svg:x="0.5in" svg:y="0.25in" svg:width="9in" svg:height="1.5in"><draw:text-box><text:p>t</text:p></draw:text-box></draw:frame>'

async function moved(name: string, dx: number): Promise<string> {
	const source = odpBytes({ body: `<draw:page draw:name="One" draw:master-page-name="M">${FRAMES}</draw:page>` })
	const d = await driveSession(source)
	const slide = d.session.deck.slides[0] as SlideRef
	const shape = (await odpParts(d.session.deck)?.slide(slide))?.shapes.find(each => each.name === name)
	const xfrm = shape?.xfrm as Xfrm

	expect(
		(
			await d.command({
				family: "shape",
				kind: "setXfrm",
				target: { slide, id: shape?.id as number },
				xfrm: { ...xfrm, x: xfrm.x + dx }
			})
		).ok
	).toBe(true)

	const saved = await d.save()

	expect(saved.result.kind).toBe("written")

	const content = text((await entriesOf(saved.bytes as Uint8Array)).get("content.xml"))

	return new RegExp(`<draw:frame [^>]*draw:name="${name}"[^>]*>`, "u").exec(content)?.[0] ?? ""
}

describe("an ODP frame in inches moved", () => {
	it("rewrites svg:x alone and keeps the other lengths as the file writes them", async () => {
		const tag = await moved("Inches", 914_400)

		expect(tag).toContain('svg:x="5.08cm"')
		expect(tag).toContain('svg:y="2in" svg:width="3in" svg:height="1in"')
	})

	it("keeps a placeholder's unchanged lengths in inches", async () => {
		const tag = await moved("Title", 12_700)

		expect(tag).toContain('svg:y="0.25in" svg:width="9in" svg:height="1.5in"')
		expect(tag).not.toContain('svg:x="0.5in"')
	})
})
