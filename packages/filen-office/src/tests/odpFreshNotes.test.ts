import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import { notesBody, notesTarget, notesText } from "../core/presentation/notes"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { entriesOf } from "./odpWriteFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"

// A converted deck's speaker notes stay speaker notes: the notes page's presentation object of class "notes" (ODF 1.3
// Part 3 §19.432) next to a page thumbnail of class "page", which LibreOffice and PowerPoint read notes from.

async function converted(notes: readonly (string | undefined)[]) {
	const pptx = buildPptx({
		slides: notes.map((text, index) => ({
			shapes: sp(2, "Title 1", 'type="title"', "", body(para(`Slide ${String(index + 1)}`))),
			...(text === undefined ? {} : { notes: text })
		}))
	})
	const fresh = await freshFromPptx(pptx)

	if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

	const entries = await entriesOf(fresh.bytes)
	const content = new TextDecoder().decode(entries.get("content.xml"))
	const back = await openOdp(bytesSource(fresh.bytes))

	if (back.kind === "refused") throw new Error(`reopen refused ${back.reason}`)

	await back.parts.parseAll()

	return { content, deck: back.deck }
}

describe("fresh ODP speaker notes", () => {
	it("writes a slide's notes as the notes presentation object, which reopens as the notes body", async () => {
		const { content, deck } = await converted([para("Speak slowly") + para("Then pause"), undefined, para("Last words")])

		expect(content).toMatch(
			/<presentation:notes><draw:page-thumbnail[^>]* draw:page-number="1" presentation:class="page"\/><draw:frame[^>]* presentation:class="notes"/u
		)
		expect(content).toMatch(/draw:page-number="3" presentation:class="page"/u)

		const [first, second, third] = deck.slides.map(ref => deck.nodes.get(ref))

		if (first === undefined || second === undefined || third === undefined) throw new Error("slides missing")

		expect(notesText(deck, first)).toBe("Speak slowly\nThen pause")
		expect(notesText(deck, third)).toBe("Last words")
		expect(notesTarget(deck, first.ref)).toBeDefined()
		expect(notesBody(first.notes === undefined ? undefined : deck.nodes.get(first.notes))?.ph?.type).toBe("body")
	})

	it("writes empty notes as a notes placeholder", async () => {
		const { content } = await converted([para("")])

		expect(content).toMatch(/<draw:frame[^>]* presentation:class="notes" presentation:placeholder="true"/u)
	})
})
