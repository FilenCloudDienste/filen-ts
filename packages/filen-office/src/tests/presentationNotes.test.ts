import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Deck, SlideRef, TextBody } from "../core/presentation/model"
import { notesTarget } from "../core/presentation/notes"
import { review } from "../dom/presentation/engine/review"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { danglingReferences, partsOf, text } from "./pptxWriteFixtures"
import { editDeckOptions } from "./presentationEditFixtures"
import { entriesOf } from "./odpWriteFixtures"

// Speaker notes: a notes slide made for a slide without one (from the deck's notes master, or with our notes master
// for a deck without), notes edited through the text family, and the undo of a notes slide made and saved, which
// gives the package back byte for byte.

function notesBody(...lines: string[]): TextBody {
	return { bodyPr: {}, paragraphs: lines.map(line => ({ pPr: {}, runs: [{ kind: "r" as const, text: line, rPr: {} }] })) }
}

function notesText(deck: Deck, slide: SlideRef): string | undefined {
	const target = notesTarget(deck, slide)
	const shape = target === undefined ? undefined : deck.nodes.get(target.slide)?.shapes.find(each => each.id === target.id)

	return shape?.text?.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join("")).join("\n")
}

function setNotes(slide: SlideRef, ...lines: string[]): DeckOp {
	return { family: "notes", kind: "setNotes", slide, body: notesBody(...lines) }
}

// A deck with no notes at all, so no notes master.
function notelessDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("One"))) },
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Two"))) }
		]
	})
}

async function reopened(bytes: Uint8Array | undefined, format: "pptx" | "odp" = "pptx") {
	if (bytes === undefined) throw new Error("not written")

	const session = await driveSession(bytes, format)

	return session
}

describe("speaker notes", () => {
	it("makes a notes slide from the deck's notes master for a slide without one, related both ways", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const slide = s.session.deck.slides[1] as SlideRef

		expect((await s.command(setNotes(slide, "Speak slowly", "Then pause"))).ok).toBe(true)

		const { bytes } = await s.save()
		const parts = await partsOf(bytes ?? new Uint8Array())
		const made = [...parts.keys()].filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name))

		expect(made).toHaveLength(2)
		expect(text(parts.get("ppt/slides/_rels/slide2.xml.rels"))).toContain("relationships/notesSlide")
		expect(await danglingReferences(bytes ?? new Uint8Array())).toEqual([])

		const back = await reopened(bytes)
		const again = back.session.deck.slides[1] as SlideRef
		const reviewed = await review(back.context, again)

		expect(reviewed.notes).toBeDefined()
		expect(notesText(back.session.deck, again)).toBe("Speak slowly\nThen pause")
	})

	it("gives a deck without a notes master ours: its part, a theme of its own and its entry in presentation.xml", async () => {
		const s = await driveSession(notelessDeck(), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		expect((await s.command(setNotes(slide, "First notes"))).ok).toBe(true)

		const { bytes } = await s.save()
		const parts = await partsOf(bytes ?? new Uint8Array())

		expect(parts.has("ppt/notesMasters/notesMaster1.xml")).toBe(true)
		expect(text(parts.get("ppt/presentation.xml"))).toMatch(
			/<p:sldMasterIdLst>.*<\/p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst><p:sldIdLst>/u
		)
		expect(text(parts.get("ppt/notesMasters/_rels/notesMaster1.xml.rels"))).toMatch(/Target="\.\.\/theme\/theme\d+\.xml"/u)
		expect(text(parts.get("[Content_Types].xml"))).toContain("presentationml.notesMaster+xml")
		expect(await danglingReferences(bytes ?? new Uint8Array())).toEqual([])

		const back = await reopened(bytes)
		const again = back.session.deck.slides[0] as SlideRef

		await review(back.context, again)

		expect(back.session.deck.notesMaster).toBeDefined()
		expect(notesText(back.session.deck, again)).toBe("First notes")
	})

	it("an undo after the save that wrote new notes gives the package back byte for byte", async () => {
		const original = notelessDeck()
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[1] as SlideRef

		await s.command(setNotes(slide, "Gone again"))
		await s.save()

		expect((await s.undo()).ok).toBe(true)

		const { bytes } = await s.save()
		const before = await partsOf(original)
		const after = await partsOf(bytes ?? new Uint8Array())

		expect([...after.keys()].sort()).toEqual([...before.keys()].sort())

		for (const [name, data] of before) expect(text(after.get(name)), name).toBe(text(data))
	})

	it("notes made and undone before a save leave the deck unchanged", async () => {
		const s = await driveSession(notelessDeck(), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await s.command(setNotes(slide, "Never saved"))
		await s.undo()

		expect((await s.save()).result.kind).toBe("unchanged")
	})

	it("a redo makes the same notes slide again, so later edits of its body redo too", async () => {
		const s = await driveSession(notelessDeck(), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await s.command(setNotes(slide, ""))

		const target = notesTarget(s.session.deck, slide)

		if (target === undefined) throw new Error("no notes body")

		await s.command({ family: "text", kind: "setText", target, body: notesBody("Typed") })
		await s.undo()
		await s.undo()

		expect(s.session.deck.nodes.get(slide)?.notes).toBeUndefined()

		await s.redo()
		await s.redo()

		expect(notesTarget(s.session.deck, slide)).toEqual(target)
		expect(notesText(s.session.deck, slide)).toBe("Typed")
	})

	it("edits notes a slide has through its notes placeholder: only the notes part changes", async () => {
		const original = buildPptx(editDeckOptions())
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		expect((await s.command(setNotes(slide, "Notes two"))).ok).toBe(true)

		const { bytes } = await s.save()
		const before = await partsOf(original)
		const after = await partsOf(bytes ?? new Uint8Array())
		const changed = [...after].filter(([name, data]) => text(before.get(name)) !== text(data)).map(([name]) => name)

		expect(changed).toEqual(["ppt/notesSlides/notesSlide1.xml"])
		expect(text(after.get("ppt/notesSlides/notesSlide1.xml"))).toContain("<a:t>Notes two</a:t>")
	})

	it("an ODP page gets presentation:notes with a page thumbnail and a notes frame; an undo after the save takes them out", async () => {
		const original = odpBytes({
			body: page(
				'<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Hi</text:p></draw:text-box></draw:frame>'
			)
		})
		const s = await driveSession(original, "odp")
		const slide = s.session.deck.slides[0] as SlideRef

		expect((await s.command(setNotes(slide, "ODF notes"))).ok).toBe(true)

		const { result, bytes } = await s.save()

		expect(result.kind).toBe("written")

		const content = text((await entriesOf(bytes ?? new Uint8Array())).get("content.xml"))

		expect(content).toMatch(
			/<presentation:notes><draw:page-thumbnail [^>]*presentation:class="page"\/><draw:frame [^>]*presentation:class="notes"><draw:text-box><text:p[^>]*>ODF notes<\/text:p><\/draw:text-box><\/draw:frame><\/presentation:notes><\/draw:page>/u
		)

		const back = await reopened(bytes, "odp")
		const again = back.session.deck.slides[0] as SlideRef

		await review(back.context, again)
		expect(notesText(back.session.deck, again)).toBe("ODF notes")

		await s.undo()

		const undone = await s.save()

		expect(text((await entriesOf(undone.bytes ?? new Uint8Array())).get("content.xml"))).toBe(
			text((await entriesOf(original)).get("content.xml"))
		)
	})

	it("duplicates a slide whose notes this session made and saved, the copy carrying its own notes, and saves again", async () => {
		const s = await driveSession(notelessDeck(), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		expect((await s.command(setNotes(slide, "Mine"))).ok).toBe(true)
		expect((await s.save()).result.kind).toBe("written")
		expect((await s.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

		const saved = await s.save()

		expect(saved.result.kind).toBe("written")
		expect(await danglingReferences(saved.bytes ?? new Uint8Array())).toEqual([])

		const back = await reopened(saved.bytes)

		expect(back.session.deck.slides).toHaveLength(3)

		for (const each of back.session.deck.slides.slice(0, 2)) {
			await review(back.context, each, { comments: false })
			expect(notesText(back.session.deck, each)).toBe("Mine")
		}
	})
})
