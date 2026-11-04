import { describe, expect, it } from "vitest"
import type { SlideRef } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { entriesOf, text } from "./odpWriteFixtures"
import { driveSession } from "./odpWriteDrive"
import { png } from "./presentationObjectsFixtures"

// A cropped picture deleted and saved, then put back by an undo and saved again: it is written from the markup the
// undo held (its frame and graphic style as the source had them), so it reads back cropped as the session shows it.

const PAGE =
	'<draw:page draw:name="One" draw:master-page-name="M">' +
	'<draw:frame draw:style-name="gr1" draw:layer="layout" svg:x="2cm" svg:y="4cm" svg:width="8cm" svg:height="4cm">' +
	'<draw:image xlink:href="Pictures/cat.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><text:p/></draw:image>' +
	"</draw:frame></draw:page>"
const STYLE =
	'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" ' +
	'fo:clip="rect(0pt, 75pt, 7.5pt, 0pt)"/></style:style>'

describe("a cropped ODP picture deleted, saved and put back by an undo", () => {
	it("is saved again from its held markup, still cropped", async () => {
		const d = await driveSession(
			odpBytes({ automatic: STYLE, body: PAGE, extra: [{ name: "Pictures/cat.png", data: png(200, 100), mediaType: "image/png" }] }),
			"odp"
		)
		const slide = d.session.deck.slides[0] as SlideRef
		const picture = async () => (await odpParts(d.session.deck)?.slide(slide))?.shapes.find(shape => shape.kind === "pic")
		const before = await picture()

		expect(before?.props?.fill).toMatchObject({ kind: "picture", crop: { l: 0, t: 0, r: 50_000, b: 10_000 } })
		expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [before?.id as number] })).ok).toBe(true)
		expect((await d.save()).result).toMatchObject({ kind: "written" })
		expect((await d.undo()).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result).toMatchObject({ kind: "written" })

		const content = text((await entriesOf(saved.bytes ?? new Uint8Array(0))).get("content.xml"))
		const fresh = await driveSession(saved.bytes ?? new Uint8Array(0), "odp")
		const back = (await odpParts(fresh.session.deck)?.slide(fresh.session.deck.slides[0] as SlideRef))?.shapes.find(
			shape => shape.kind === "pic"
		)

		expect(content).toContain('draw:style-name="gr1" draw:layer="layout"')
		expect(content).toContain('fo:clip="rect(0pt, 75pt, 7.5pt, 0pt)"')
		expect(back?.props?.fill).toMatchObject({ kind: "picture", crop: { l: 0, t: 0, r: 50_000, b: 10_000 } })
	})
})
