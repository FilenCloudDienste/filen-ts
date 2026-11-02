import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// A page without notes given notes, saved, deleted, saved, then put back by an undo: the save writes it back with its
// notes (the notes page the first save wrote, held by the delete), and it saves on. The file's default graphic style
// fills and strokes (as a PowerPoint export's does) and its masters write no class styles: the notes body the session
// made inherits, as LibreOffice's own notes style gives it (no fill, no line).

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

function deck(): Uint8Array {
	return odpBytes({
		styles: '<style:default-style style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#156082" draw:stroke="solid" svg:stroke-color="#042433"/></style:default-style>',
		body: ["One", "Two", "Three"]
			.map(
				name =>
					`<draw:page draw:name="${name}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>${name}</text:p></draw:text-box></draw:frame></draw:page>`
			)
			.join("")
	})
}

async function notesBodyProps(bytes: Uint8Array | undefined): Promise<unknown> {
	if (bytes === undefined) throw new Error("no saved file")

	const d = await driveSession(bytes, "odp")
	const slide = d.session.deck.slides[1] as SlideRef

	await review(d.context, slide)

	const node = d.session.deck.nodes.get(slide) as SlideNode
	const notes = node.notes === undefined ? undefined : (d.session.deck.nodes.get(node.notes) as SlideNode | undefined)

	return notes?.shapes.find(shape => shape.ph?.type === "body")?.props
}

async function notesOf(bytes: Uint8Array | undefined): Promise<string[]> {
	if (bytes === undefined) throw new Error("no saved file")

	const d = await driveSession(bytes, "odp")
	const out: string[] = []

	for (const slide of d.session.deck.slides) {
		await review(d.context, slide)

		const node = d.session.deck.nodes.get(slide) as SlideNode
		const notes = node.notes === undefined ? undefined : (d.session.deck.nodes.get(node.notes) as SlideNode | undefined)
		const body = notes?.shapes.find(shape => shape.ph?.type === "body")?.text

		out.push(body?.paragraphs.map(p => p.runs.map(run => ("text" in run ? run.text : "")).join("")).join("/") ?? "")
	}

	return out
}

describe("a page given notes, saved, deleted, saved and put back by an undo", () => {
	it("saves with its notes, and saves an edit of them", async () => {
		const d = await driveSession(deck(), "odp")
		const slide = d.session.deck.slides[1] as SlideRef

		for (const each of d.session.deck.slides) await review(d.context, each)

		expect((await d.command({ family: "notes", kind: "setNotes", slide, body: plain("Spoken") } as DeckOp)).ok).toBe(true)
		const first = await d.save()

		expect(first.result.kind).toBe("written")
		// Its notes body reads as LibreOffice draws it: under no class style of the file's, no fill and no line.
		expect(await notesBodyProps(first.bytes)).toMatchObject({ fill: "none", ln: "none" })
		expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)

		const restored = await d.save()

		expect(restored.result).toMatchObject({ kind: "written" })
		expect(await notesOf(restored.bytes)).toEqual(["", "Spoken", ""])

		expect((await d.command({ family: "notes", kind: "setNotes", slide, body: plain("Spoken again") } as DeckOp)).ok).toBe(true)

		const edited = await d.save()

		expect(edited.result).toMatchObject({ kind: "written" })
		expect(await notesOf(edited.bytes)).toEqual(["", "Spoken again", ""])
	})
})
