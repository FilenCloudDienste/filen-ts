import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { partsOf } from "./pptxWriteFixtures"

// A slide with notes duplicated, the copy's notes edited, both undone and redone: the redone copy's notes are the
// same notes slide as before, so the redone edit finds them and the file writes.

const lines = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r" as const, text, rPr: {} }] }] })

// A deck of two slides whose first has notes read from the file (written by our own save, then opened again).
async function withFileNotes(format: "odp" | "pptx"): Promise<Uint8Array> {
	const source =
		format === "pptx"
			? buildPptx({
					slides: [0, 1].map(k => ({
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(k)}`)))
					}))
				})
			: odpBytes({
					body: [0, 1]
						.map(
							k =>
								`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(k)}</text:p></draw:text-box></draw:frame></draw:page>`
						)
						.join("")
				})
	const d = await driveSession(source, format)

	expect(
		(await d.command({ family: "notes", kind: "setNotes", slide: d.session.deck.slides[0] as SlideRef, body: lines("file notes") })).ok
	).toBe(true)

	const saved = await d.save()

	if (saved.bytes === undefined) throw new Error("not saved")

	return saved.bytes
}

const TDF = join(CORPUS_DIR, "odp", "lo__tdf90627.odp")
const decks: { readonly label: string; readonly format: "odp" | "pptx"; readonly make?: () => Promise<Uint8Array> }[] = [
	{ label: "pptx with notes", format: "pptx", make: () => withFileNotes("pptx") },
	{ label: "odp with notes", format: "odp", make: () => withFileNotes("odp") },
	...(existsSync(TDF)
		? [{ label: "lo__tdf90627.odp", format: "odp" as const, make: () => Promise.resolve(new Uint8Array(readFileSync(TDF))) }]
		: [])
]

describe("a duplicated slide's notes across undo and redo", () => {
	for (const { label, format, make } of decks)
		for (const save of [false, true])
			it(`${label}: duplicate, edit the copy's notes, undo both, redo both${save ? ", saved before the undo" : ""}`, async () => {
				const d = await driveSession(await (make as () => Promise<Uint8Array>)(), format)
				let slide: SlideRef | undefined

				for (const each of d.session.deck.slides) {
					if ((await review(d.context, each, { comments: false })).notes !== undefined) {
						slide = each
						break
					}
				}

				if (slide === undefined) throw new Error("no slide with notes")

				expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

				const copyAt = d.session.deck.slides.indexOf(slide) + 1
				const notes = (await review(d.context, d.session.deck.slides[copyAt] as SlideRef, { comments: false })).notes

				if (notes === undefined) throw new Error("the copy has no notes")

				expect((await d.command({ family: "text", kind: "setText", target: notes, body: lines("copy edit") })).ok).toBe(true)

				if (save) expect((await d.save()).result.kind).toBe("written")

				expect((await d.undo()).ok).toBe(true)
				expect((await d.undo()).ok).toBe(true)
				expect((await d.redo()).ok).toBe(true)
				expect((await d.redo()).ok).toBe(true)

				const copy = d.session.deck.slides[copyAt] as SlideRef
				const redone = await review(d.context, copy, { comments: false })

				expect(redone.notes).toEqual(notes)
				expect(redone.notesText).toBe("copy edit")
				// Redone to the state saved before the undo, the deck is that state again: nothing to write.
				expect((await d.save()).result.kind).toBe(save ? "unchanged" : "written")
			})
	it("a duplicate with its notes, undone and saved, then redone: the save of the same state writes the same bytes", async () => {
		const d = await driveSession(await withFileNotes("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

		const first = await d.save()

		expect((await d.undo()).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.redo()).ok).toBe(true)

		const again = await d.save()

		if (first.bytes === undefined || again.bytes === undefined) throw new Error("not saved")

		const before = await partsOf(first.bytes)
		const after = await partsOf(again.bytes)

		expect([...after.keys()].sort()).toEqual([...before.keys()].sort())

		for (const [name, bytes] of before)
			expect(Buffer.from(after.get(name) ?? new Uint8Array()).equals(Buffer.from(bytes)), name).toBe(true)
	})
	it("empty notes are the same model made by notes.setNotes or left by undoing their text: the same save", async () => {
		const d = await driveSession(await withFileNotes("pptx"), "pptx")
		const slide = d.session.deck.slides[1] as SlideRef

		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)
		expect((await d.command({ family: "notes", kind: "setNotes", slide, body: { bodyPr: {}, paragraphs: [] } })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: false })).ok).toBe(true)

		const first = await d.save()
		const notes = (await review(d.context, slide, { comments: false })).notes

		if (notes === undefined) throw new Error("no notes")

		expect((await d.command({ family: "text", kind: "setText", target: notes, body: lines("Then") })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)

		const again = await d.save()

		if (first.bytes === undefined || again.bytes === undefined) throw new Error("not saved")

		const before = await partsOf(first.bytes)
		const after = await partsOf(again.bytes)

		for (const [name, bytes] of before)
			if (/notesSlide\d+\.xml$/u.test(name))
				expect(Buffer.from(after.get(name) ?? new Uint8Array()).equals(Buffer.from(bytes)), name).toBe(true)
	})
})

// Notes the session made, saved, then edited: a copy of their slide writes them as the model has them, never as the
// saved part held them.
describe("a duplicate of a slide whose notes this session made and saved", () => {
	const deckOf = (format: "odp" | "pptx"): Uint8Array =>
		format === "pptx"
			? buildPptx({
					slides: [0, 1, 2].map(k => ({
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(k)}`)))
					}))
				})
			: odpBytes({
					body: [0, 1, 2]
						.map(
							k =>
								`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(k)}</text:p></draw:text-box></draw:frame></draw:page>`
						)
						.join("")
				})
	type Drive = Awaited<ReturnType<typeof driveSession>>
	const notesText = async (d: Drive): Promise<string[]> => {
		const out: string[] = []

		for (const slide of d.session.deck.slides) {
			const target = (await review(d.context, slide, { comments: false })).notes
			const node = target === undefined ? undefined : d.session.deck.nodes.get(target.slide)
			const shape = node?.shapes.find(each => each.id === target?.id)

			out.push(
				shape?.text?.paragraphs
					.map(paragraph => paragraph.runs.map(run => (run.kind === "r" ? run.text : "")).join(""))
					.join("/") ?? "-"
			)
		}

		return out
	}
	const typeNotes = async (d: Drive, slide: SlideRef, text: string, burst: number): Promise<void> => {
		const target = (await review(d.context, slide, { comments: false })).notes

		if (target === undefined) throw new Error("no notes")

		expect((await d.command({ family: "text", kind: "setText", target, body: lines(text), burst })).ok).toBe(true)
	}

	for (const format of ["pptx", "odp"] as const)
		for (const deleteCopy of [false, true])
			it(`${format}: notes saved, undone, the slide duplicated, notes made again${deleteCopy ? ", the copy deleted" : ""}: the file's notes are the model's`, async () => {
				const d = await driveSession(deckOf(format), format)
				const slide = d.session.deck.slides[1] as SlideRef

				expect((await d.command({ family: "notes", kind: "setNotes", slide, body: { bodyPr: {}, paragraphs: [] } })).ok).toBe(true)
				await typeNotes(d, slide, "N2", 1)
				expect((await d.save()).result.kind).toBe("written")
				expect((await d.undo()).ok).toBe(true)
				expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
				expect((await d.command({ family: "notes", kind: "setNotes", slide, body: { bodyPr: {}, paragraphs: [] } })).ok).toBe(true)
				await typeNotes(d, slide, "N6", 2)

				if (deleteCopy)
					expect((await d.command({ family: "slide", kind: "delete", slides: [d.session.deck.slides[2] as SlideRef] })).ok).toBe(
						true
					)

				const saved = await d.save()

				expect(saved.result.kind).toBe("written")

				const model = await notesText(d)

				expect(await notesText(await driveSession(saved.bytes as Uint8Array, format))).toEqual(model)
				expect((await d.save()).result.kind).toBe("unchanged")
			})

	for (const format of ["pptx", "odp"] as const)
		for (const variant of ["the original edited before", "the copy edited", "the original edited after"] as const)
			it(`${format}: ${variant}: the file's notes are the model's`, async () => {
				const d = await driveSession(deckOf(format), format)
				const slide = d.session.deck.slides[1] as SlideRef

				expect((await d.command({ family: "notes", kind: "setNotes", slide, body: { bodyPr: {}, paragraphs: [] } })).ok).toBe(true)
				await typeNotes(d, slide, "OLD", 1)
				expect((await d.save()).result.kind).toBe("written")

				if (variant === "the original edited before") await typeNotes(d, slide, "NEW", 2)

				expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

				if (variant === "the copy edited") await typeNotes(d, d.session.deck.slides[2] as SlideRef, "COPY", 3)
				if (variant === "the original edited after") await typeNotes(d, slide, "AFTER", 4)

				const saved = await d.save()

				expect(saved.result.kind).toBe("written")

				const model = await notesText(d)

				expect(await notesText(await driveSession(saved.bytes as Uint8Array, format))).toEqual(model)
				expect((await d.save()).result.kind).toBe("unchanged")
			})
})

// A copy saved, taken out by an undo and made again by a redo (the package still binds its part to it): an edit of the
// copy made then is in the next save.
describe("a duplicate saved, undone and redone, then edited", () => {
	for (const save of [false, true])
		it(`pptx: the copy's text edit is written${save ? " (with a second copy of it)" : ""}`, async () => {
			const d = await driveSession(
				buildPptx({
					slides: [0, 1, 2].map(k => ({
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(k)}`)))
					}))
				}),
				"pptx"
			)
			const texts = async (drive: typeof d): Promise<string[]> => {
				const out: string[] = []

				for (const slide of drive.session.deck.slides) {
					await review(drive.context, slide)

					const node = drive.session.deck.nodes.get(slide)

					out.push(
						node?.shapes[0]?.text?.paragraphs
							.map(p => p.runs.map(run => (run.kind === "r" ? run.text : "")).join(""))
							.join("/") ?? "-"
					)
				}

				return out
			}

			for (const slide of d.session.deck.slides) await review(d.context, slide)

			expect((await d.command({ family: "slide", kind: "duplicate", slide: d.session.deck.slides[0] as SlideRef })).ok).toBe(true)
			expect((await d.save()).result.kind).toBe("written")
			expect((await d.undo()).ok).toBe(true)
			expect((await d.redo()).ok).toBe(true)

			const copy = d.session.deck.slides[1] as SlideRef

			await review(d.context, copy)

			const shape = d.session.deck.nodes.get(copy)?.shapes[0]

			if (shape === undefined) throw new Error("no shape")

			expect(
				(await d.command({ family: "text", kind: "setText", target: { slide: copy, id: shape.id }, body: lines("EDIT") })).ok
			).toBe(true)

			if (save) expect((await d.command({ family: "slide", kind: "duplicate", slide: copy })).ok).toBe(true)

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect(await texts(await driveSession(saved.bytes as Uint8Array, "pptx"))).toEqual(await texts(d))
			expect((await d.save()).result.kind).toBe("unchanged")
		})
})
