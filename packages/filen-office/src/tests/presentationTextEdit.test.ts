import { describe, expect, it } from "vitest"
import { EditorState, TextSelection } from "prosemirror-state"
import { emitPptx } from "../core/pptx/write/emit"
import type { Paragraph, ShapeNode, TextBody } from "../core/presentation/model"
import { bodyToDoc, docToBody, presentationTextSchema, RUN_MARK } from "../core/presentation/text/schema"
import { splitParagraph, toggleRunFlag } from "../core/presentation/edit/commands/text"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { changedParts, partsOf, saveEdits, text } from "./pptxWriteFixtures"

// Text edits end to end in the worker: the editor's document converts back to a body that keeps every untouched
// paragraph (and its source) as it was; setText puts a body on a shape, its undo restores the source body exactly,
// and the pptx writer rewrites only the edited slide's text.

const EDIT = { emit: emitPptx } as never

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Hello world"))) +
					sp(
						3,
						"Box",
						undefined,
						`${xfrm(100, 200, 3000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("First") + para("Second", ' b="1"'))
					)
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Other slide"))) }
		]
	})
}

function shapeText(shape: ShapeNode | undefined): string[] {
	return (shape?.text?.paragraphs ?? []).map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
}

function stateOf(text: TextBody): { state: EditorState; origins: ReturnType<typeof bodyToDoc>["origins"] } {
	const { doc, origins } = bodyToDoc(text)

	return { state: EditorState.create({ doc, schema: presentationTextSchema }), origins }
}

describe("presentation text editing schema", () => {
	it("an untouched document converts back to the very paragraphs it was built from", () => {
		const source: TextBody = {
			bodyPr: { wrap: true },
			paragraphs: [
				{
					pPr: { algn: "ctr" },
					runs: [
						{ kind: "r", text: "A", rPr: { b: true } },
						{ kind: "r", text: "B", rPr: { b: true } }
					]
				},
				{
					pPr: {},
					runs: [
						{ kind: "fld", type: "slidenum", id: "{1}", text: "3", rPr: {} },
						{ kind: "br", rPr: {} }
					],
					endRPr: { sz: 2400 }
				}
			]
		}
		const { state, origins } = stateOf(source)
		const back = docToBody(state.doc, source, origins)

		expect(back.paragraphs[0]).toBe(source.paragraphs[0])
		expect(back.paragraphs[1]).toBe(source.paragraphs[1])
		expect(back.bodyPr).toBe(source.bodyPr)
	})

	it("an edited paragraph keeps its source ref once: a split's second half names none", () => {
		const src = { format: "pptx" as const, part: "/ppt/slides/slide1.xml", node: 42, epoch: 0 }
		const source: TextBody = {
			bodyPr: {},
			paragraphs: [{ pPr: { lvl: 1 }, runs: [{ kind: "r", text: "Hello", rPr: { sz: 2000 } }], src }]
		}
		const { state, origins } = stateOf(source)
		const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)))
		let next = caret

		splitParagraph(caret, tr => {
			next = caret.apply(tr)
		})

		const back = docToBody(next.doc, source, origins)

		expect(back.paragraphs.map(paragraph => paragraph.src)).toEqual([src, undefined])
		expect(back.paragraphs.map(paragraph => paragraph.pPr)).toEqual([{ lvl: 1 }, { lvl: 1 }])
		expect(back.paragraphs.map(paragraph => paragraph.runs)).toEqual([
			[{ kind: "r", text: "He", rPr: { sz: 2000 } }],
			[{ kind: "r", text: "llo", rPr: { sz: 2000 } }]
		])
	})

	it("text typed where no run was takes the paragraph mark's properties", () => {
		const source: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [], endRPr: { sz: 3200, lang: "de-DE" } }] }
		const { state, origins } = stateOf(source)
		const typed = state.apply(state.tr.insertText("Neu", 1))
		const back = docToBody(typed.doc, source, origins)

		expect(back.paragraphs[0]?.runs).toEqual([{ kind: "r", text: "Neu", rPr: { sz: 3200, lang: "de-DE" } }])
	})
})

describe("presentation text ops", () => {
	it("typing mid-run in a title rewrites only that slide's text, and undo saves as unchanged", async () => {
		const h = await editHarness(deck(), EDIT)
		const slide = await h.slide(0)
		const title = shapeById(slide.shapes, 2) as ShapeNode
		const { state, origins } = stateOf(title.text as TextBody)
		const typed = state.apply(state.tr.insertText(" big", 6))
		const result = await h.command({
			family: "text",
			kind: "setText",
			target: { slide: slide.ref, id: 2 },
			body: docToBody(typed.doc, title.text as TextBody, origins)
		})

		expect(result).toMatchObject({ ok: true, dirty: true })
		expect(shapeText(shapeById(slide.shapes, 2))).toEqual(["Hello big world"])

		const before = deck()
		const saved = await saveEdits(h, (result as { revision: number }).revision)

		expect(await changedParts(before, saved)).toEqual(["ppt/slides/slide1.xml"])

		const xml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(xml).toContain("<a:t>Hello big world</a:t>")
		// The untouched box keeps its source bytes.
		expect(xml).toContain('<a:r><a:rPr lang="en-GB" b="1"/><a:t>Second</a:t></a:r>')

		expect(await h.undo()).toMatchObject({ ok: true, dirty: true })
		expect(shapeText(shapeById(slide.shapes, 2))).toEqual(["Hello world"])
		h.close()
	})

	it("bold over a range splits the run, and an undo back to the saved state leaves no changes", async () => {
		const h = await editHarness(deck(), EDIT)
		const slide = await h.slide(0)
		const box = shapeById(slide.shapes, 3) as ShapeNode
		const { state, origins } = stateOf(box.text as TextBody)
		const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2, 4)))
		let bolded = selected

		toggleRunFlag("b")(selected, tr => {
			bolded = selected.apply(tr)
		})

		const next = docToBody(bolded.doc, box.text as TextBody, origins)

		expect(next.paragraphs[0]?.runs).toEqual([
			{ kind: "r", text: "F", rPr: { lang: "en-GB" } },
			{ kind: "r", text: "ir", rPr: { lang: "en-GB", b: true } },
			{ kind: "r", text: "st", rPr: { lang: "en-GB" } }
		])
		// The untouched second paragraph is the source one.
		expect(next.paragraphs[1]).toBe(box.text?.paragraphs[1])

		expect(await h.command({ family: "text", kind: "setText", target: { slide: slide.ref, id: 3 }, body: next })).toMatchObject({
			ok: true
		})
		expect(sessionEdits(h.session).changes().empty).toBe(false)
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect(sessionEdits(h.session).changes().empty).toBe(true)
		h.close()
	})

	it("adds a bullet paragraph and writes it as a:p with a:buChar", async () => {
		const h = await editHarness(deck(), EDIT)
		const slide = await h.slide(0)
		const box = shapeById(slide.shapes, 3) as ShapeNode
		const added: Paragraph = {
			pPr: { marL: 342900, indent: -342900, bullet: { kind: "char", char: "•" } },
			runs: [{ kind: "r", text: "Point", rPr: { lang: "en-GB" } }]
		}
		const next: TextBody = { ...(box.text as TextBody), paragraphs: [...(box.text as TextBody).paragraphs, added] }
		const result = await h.command({ family: "text", kind: "setText", target: { slide: slide.ref, id: 3 }, body: next })
		const saved = await saveEdits(h, (result as { revision: number }).revision)
		const xml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(xml).toMatch(
			/<a:pPr marL="342900" indent="-342900"><a:buChar char="•"\/><\/a:pPr><a:r><a:rPr lang="en-GB"\/><a:t>Point<\/a:t><\/a:r>/u
		)
		h.close()
	})

	it("typing bursts coalesce into one undo step", async () => {
		const h = await editHarness(deck(), EDIT)
		const slide = await h.slide(1)
		const title = shapeById(slide.shapes, 2) as ShapeNode
		const source = title.text as TextBody
		const { state, origins } = stateOf(source)
		let current = state

		for (const [index, char] of [..."abc"].entries()) {
			current = current.apply(current.tr.insertText(char, 1 + index))
			expect(
				await h.command({
					family: "text",
					kind: "setText",
					target: { slide: slide.ref, id: 2 },
					body: docToBody(current.doc, source, origins),
					burst: 1
				})
			).toMatchObject({ ok: true })
		}

		expect(shapeText(shapeById(slide.shapes, 2))).toEqual(["abcOther slide"])
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect(shapeText(shapeById(slide.shapes, 2))).toEqual(["Other slide"])
		h.close()
	})

	it("refuses text XML cannot hold, a shape that holds no body, and an unknown shape", async () => {
		const h = await editHarness(deck(), EDIT)
		const slide = await h.slide(0)
		const bad: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "a\u0001b", rPr: {} }] }] }

		expect(await h.command({ family: "text", kind: "setText", target: { slide: slide.ref, id: 3 }, body: bad })).toEqual({
			ok: false,
			refusal: "malformed"
		})
		expect(await h.command({ family: "text", kind: "setText", target: { slide: slide.ref, id: 99 }, body: bad })).toEqual({
			ok: false,
			refusal: "notFound"
		})
		h.close()
	})

	it("the autofit result is written to bodyPr and undone to the body the file had", async () => {
		const h = await editHarness(deck(), EDIT)
		const slide = await h.slide(0)
		const target = { slide: slide.ref, id: 3 }

		expect(
			await h.command({ family: "text", kind: "setAutofitResult", target, fontScale: 62_500, lnSpcReduction: 20_000 })
		).toMatchObject({ ok: true })
		expect(shapeById(slide.shapes, 3)?.text?.bodyPr).toMatchObject({ autofit: "normal", fontScale: 0.625, lineSpacingReduction: 0.2 })
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect(shapeById(slide.shapes, 3)?.text?.bodyPr).toEqual({})
		h.close()
	})

	it("the run mark keeps a whole a:rPr, so a copy's markup names the basic formatting", () => {
		const mark = RUN_MARK.create({ rPr: { b: true, u: "sng", sz: 2000 } })

		expect(RUN_MARK.spec.toDOM?.(mark, true)).toEqual(["b", ["u", 0]])
	})
})
