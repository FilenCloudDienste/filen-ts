import { describe, expect, it } from "vitest"
import { TIMING_XML } from "./animFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A condition list the timing writer writes again (its conditions changed against the file it saves over) is spelled
// as the element it replaces: a deck that writes an empty element as "<p:cond delay="0" />" keeps that spelling, so
// a state saved again (an undo back to it after a save) writes the bytes it was saved with.

function deck(): Uint8Array {
	// The space before "/>" as Google Slides and LibreOffice write it.
	const timing = TIMING_XML.replace(/([^ ])\/>/gu, "$1 />")

	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title", 'type="title"', xfrm(100, 100, 5000000, 800000), body(para("Animated"))) +
					sp(3, "Body", 'idx="1"', xfrm(100, 1000000, 5000000, 3000000), body(para("One") + para("Two"))) +
					sp(4, "Box", undefined, xfrm(6000000, 1000000, 1000000, 1000000)),
				after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}`
			}
		]
	})
}

const timingOf = async (bytes: Uint8Array | undefined): Promise<string | undefined> =>
	bytes === undefined ? undefined : /<p:timing>.*<\/p:timing>/su.exec(text((await entriesOf(bytes)).get("ppt/slides/slide1.xml")))?.[0]

describe("a timing condition list written again", () => {
	it("keeps the source's spelling of empty elements: an undo after a save writes the source's timing", async () => {
		const source = deck()
		const original = await timingOf(source)
		const h = await driveSession(source, "pptx")
		const slide = h.session.deck.slides[0] ?? (0 as never)

		expect(original).toContain('<p:cond delay="0" />')
		expect((await h.command({ family: "timing", kind: "setEffectTiming", slide, node: 10, timing: { delayMs: 300 } })).ok).toBe(true)
		expect(await timingOf((await h.save()).bytes)).toContain('<p:cond delay="300" />')
		expect((await h.undo()).ok).toBe(true)
		expect(await timingOf((await h.save()).bytes)).toBe(original)
	})
})
