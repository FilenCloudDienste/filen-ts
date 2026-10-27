import { describe, expect, it } from "vitest"
import { EditorState, TextSelection } from "prosemirror-state"
import { emitPptx } from "../core/pptx/write/emit"
import type { ShapeNode, TextBody } from "../core/presentation/model"
import { horizontalMove, plainTextSlice, setHyperlink } from "../core/presentation/edit/commands/text"
import { bodyToDoc, docToBody, presentationTextSchema, RUN_MARK } from "../core/presentation/text/schema"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { partsOf, saveEdits, text } from "./pptxWriteFixtures"

const EDIT = { emit: emitPptx } as never

function stateWith(textValue: string): EditorState {
	const { doc } = bodyToDoc({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: textValue, rPr: {} }] }] })

	return EditorState.create({ doc, schema: presentationTextSchema, selection: TextSelection.atEnd(doc) })
}

describe("presentation text input", () => {
	it("ArrowLeft steps over a whole grapheme cluster (combining mark, flag, ZWJ emoji)", () => {
		for (const cluster of ["é", "\u{1F1E9}\u{1F1EA}", "\u{1F468}‍\u{1F469}‍\u{1F467}", "❤️"]) {
			const state = stateWith(`a${cluster}`)
			let next = state

			horizontalMove(
				-1,
				"char",
				false
			)(state, tr => {
				next = state.apply(tr)
			})
			// After the move the caret must sit right after "a" (position 2), not inside the cluster.
			expect(next.selection.head, JSON.stringify(cluster)).toBe(2)
		}
	})

	it("a link whose address holds a control character is never set, and never reaches the saved package", async () => {
		const bytes = buildPptx({
			slides: [
				{
					shapes: sp(
						3,
						"Box",
						undefined,
						`${xfrm(100, 200, 3000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("Click here"))
					)
				}
			]
		})
		const h = await editHarness(bytes, EDIT)
		const slide = await h.slide(0)
		const box = shapeById(slide.shapes, 3) as ShapeNode
		const { doc, origins } = bodyToDoc(box.text as TextBody)
		let state = EditorState.create({ doc, schema: presentationTextSchema })

		state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
		setHyperlink({ kind: "url", href: "https://example.com/a\u0007b" })(state, tr => {
			state = state.apply(tr)
		})

		const set = state.doc.child(0).child(0).marks[0]?.attrs["rPr"] as { hlinkClick?: { href: string } }

		// Stored percent-encoded, as the link is stored (presentationHref).
		expect(set.hlinkClick?.href).toBe("https://example.com/a%07b")

		const raw = state.apply(
			state.tr.addMark(1, 6, RUN_MARK.create({ rPr: { hlinkClick: { kind: "url", href: "https://example.com/a\u0007b" } } }))
		)

		// A body that holds one anyway (built elsewhere) is refused by the command.
		expect(
			await h.command({
				family: "text",
				kind: "setText",
				target: { slide: slide.ref, id: 3 },
				body: docToBody(raw.doc, box.text as TextBody, origins)
			})
		).toMatchObject({ ok: false, refusal: "malformed" })

		const result = await h.command({
			family: "text",
			kind: "setText",
			target: { slide: slide.ref, id: 3 },
			body: docToBody(state.doc, box.text as TextBody, origins)
		})

		expect(result.ok).toBe(true)

		if (result.ok) {
			const saved = await saveEdits(h, (result as { revision: number }).revision)
			const rels = text((await partsOf(saved)).get("ppt/slides/_rels/slide1.xml.rels"))

			expect(rels.includes("\u0007")).toBe(false)
		}
		h.close()
	})

	it("plain text pasted with a vertical tab (a soft line break in other apps' plain text) commits", async () => {
		const bytes = buildPptx({
			slides: [
				{
					shapes: sp(
						3,
						"Box",
						undefined,
						`${xfrm(100, 200, 3000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("Start"))
					)
				}
			]
		})
		const h = await editHarness(bytes, EDIT)
		const slide = await h.slide(0)
		const box = shapeById(slide.shapes, 3) as ShapeNode
		const { doc, origins } = bodyToDoc(box.text as TextBody)
		let state = EditorState.create({ doc, schema: presentationTextSchema, selection: TextSelection.atEnd(doc) })

		state = state.apply(state.tr.replaceSelection(plainTextSlice(" line one\u000bline two", {}, null)))

		const result = await h.command({
			family: "text",
			kind: "setText",
			target: { slide: slide.ref, id: 3 },
			body: docToBody(state.doc, box.text as TextBody, origins)
		})

		expect(result).toMatchObject({ ok: true })
		h.close()
	})

	it("a vertical tab in pasted plain text is a line break, and other control characters are taken out", () => {
		const slice = plainTextSlice("one\u000btwo\u0007three", {}, null)
		const kinds: string[] = []

		slice.content.forEach(paragraph => {
			paragraph.forEach(child => kinds.push(child.isText ? `text:${child.text ?? ""}` : child.type.name))
		})

		expect(kinds).toEqual(["text:one", "br", "text:twothree"])
	})

	it("stores a link with spaces percent-encoded, as the save path classifies it", () => {
		let state = stateWith("Click here")

		state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
		setHyperlink({ kind: "url", href: "  https://example.com/my file.pdf " })(state, tr => {
			state = state.apply(tr)
		})

		const rPr = state.doc.child(0).child(0).marks[0]?.attrs["rPr"] as { hlinkClick?: { href: string } }

		expect(rPr.hlinkClick?.href).toBe("https://example.com/my%20file.pdf")
		expect(setHyperlink({ kind: "url", href: "javascript:alert(1)" })(state)).toBe(false)
	})

	it("ArrowRight steps over a whole grapheme cluster too", () => {
		for (const cluster of ["e\u0301", "\u{1F1E9}\u{1F1EA}", "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"]) {
			const { doc } = bodyToDoc({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: `${cluster}b`, rPr: {} }] }] })
			const state = EditorState.create({ doc, schema: presentationTextSchema, selection: TextSelection.create(doc, 1) })
			let next = state

			horizontalMove(
				1,
				"char",
				false
			)(state, tr => {
				next = state.apply(tr)
			})
			expect(next.selection.head, JSON.stringify(cluster)).toBe(1 + cluster.length)
		}
	})
})
