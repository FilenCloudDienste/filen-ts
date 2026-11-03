import { describe, expect, it } from "vitest"
import type { Paragraph, SlideRef, TextBody } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// A body the save wrote anew with a paragraph taken out: after the rebase, each paragraph that is left names the
// element it was written as in the saved file (its place among the written paragraphs), not the element at its old
// path (the next paragraph's, or none).

const PAGE =
	'<draw:page draw:name="a" draw:master-page-name="M">' +
	'<draw:frame draw:name="Body" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="9cm"><draw:text-box>' +
	"<text:list><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item>" +
	"<text:list-item><text:p>Three</text:p></text:list-item></text:list></draw:text-box></draw:frame></draw:page>"

describe("an ODP body rewritten without a paragraph, rebased", () => {
	it("names the saved file's elements of the paragraphs that are left", async () => {
		const d = await driveSession(odpBytes({ body: PAGE }), "odp")
		const parts = () => odpParts(d.session.deck)
		const slide = async () => parts()?.slide(d.session.deck.slides[0] as SlideRef)
		const body = (await slide())?.shapes.find(shape => shape.name === "Body")
		const text = body?.text as TextBody
		const edited: TextBody = { ...text, paragraphs: text.paragraphs.slice(1) }

		expect(
			(
				await d.command({
					family: "text",
					kind: "setText",
					target: { slide: d.session.deck.slides[0] as SlideRef, id: body?.id as number },
					body: edited
				})
			).ok
		).toBe(true)
		const saved = await d.save()

		expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

		const after = (await slide())?.shapes.find(shape => shape.name === "Body")
		const fresh = await driveSession(saved.bytes ?? new Uint8Array(0), "odp")
		const reread = (await odpParts(fresh.session.deck)?.slide(fresh.session.deck.slides[0] as SlideRef))?.shapes.find(
			shape => shape.name === "Body"
		)
		const node = (paragraph: Paragraph | undefined) => (paragraph?.src?.format === "odp" ? paragraph.src.node : undefined)

		expect(after?.text?.paragraphs.map(node)).toEqual(reread?.text?.paragraphs.map(node))
		expect(
			after?.text?.paragraphs.every(
				paragraph => paragraph.src?.format === "odp" && paragraph.src.epoch === (after.src?.format === "odp" ? after.src.epoch : -1)
			)
		).toBe(true)
	})
})
