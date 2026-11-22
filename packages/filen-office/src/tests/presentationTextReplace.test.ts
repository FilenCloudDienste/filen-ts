import { describe, expect, it } from "vitest"
import { EditorState, TextSelection } from "prosemirror-state"
import { plainTextBody } from "../core/presentation/edit/commands/text"
import type { Paragraph, Run, TextBody } from "../core/presentation/model"
import { bodyToDoc, docToBody, presentationTextSchema } from "../core/presentation/text/schema"
import { bodyPlainText, replaceBodyText, replaceSlideText, slidePlainRange, slideRangeText } from "../react/presentation/edit/text/replace"

function run(text: string, sz = 1800): Run {
	return { kind: "r", text, rPr: { sz } }
}

function bullets(): TextBody {
	return {
		bodyPr: {},
		paragraphs: [
			{ pPr: { lvl: 0 }, runs: [run("Revenue up", 2400), run(" 12 %", 2000)] },
			{ pPr: { lvl: 1, algn: "ctr" }, runs: [run("Costs flat", 1600)] },
			{ pPr: { lvl: 2 }, runs: [run("Hiring", 1400), { kind: "br", rPr: {} }, run("paused", 1200)] }
		]
	}
}

function stateOf(body: TextBody) {
	const { doc, origins } = bodyToDoc(body)

	return { state: EditorState.create({ doc, schema: presentationTextSchema }), origins, body }
}

function whole(state: EditorState) {
	return { from: TextSelection.atStart(state.doc).from, to: TextSelection.atEnd(state.doc).to }
}

function paragraphsOf(body: TextBody): { lvl: number | undefined; algn: string | undefined; runs: string[]; sz: (number | undefined)[] }[] {
	return body.paragraphs.map((paragraph: Paragraph) => ({
		lvl: paragraph.pPr.lvl,
		algn: paragraph.pPr.algn,
		runs: paragraph.runs.map(item => (item.kind === "r" ? item.text : item.kind === "br" ? "\n" : "?")),
		sz: paragraph.runs.map(item => (item.kind === "r" ? item.rPr.sz : undefined))
	}))
}

describe("replacing a slide body's text", () => {
	it("reads a range's lines at paragraph ends and line breaks", () => {
		const { state } = stateOf(bullets())

		expect(slideRangeText(state.doc, whole(state))).toBe("Revenue up 12 %\nCosts flat\nHiring\npaused")
		expect(slideRangeText(state.doc, whole(state))).toBe(state.doc.textBetween(whole(state).from, whole(state).to, "\n"))
	})

	it("keeps each paragraph's properties and each line's first run props when the lines match", () => {
		const { state, origins, body } = stateOf(bullets())
		const tr = replaceSlideText(state, whole(state), "Umsatz +12 %\nKosten stabil\nEinstellungen\npausiert")

		expect(tr).not.toBeNull()

		const next = state.apply(tr ?? state.tr)
		const out = paragraphsOf(docToBody(next.doc, body, origins))

		expect(out).toEqual([
			{ lvl: 0, algn: undefined, runs: ["Umsatz +12 %"], sz: [2400] },
			{ lvl: 1, algn: "ctr", runs: ["Kosten stabil"], sz: [1600] },
			{ lvl: 2, algn: undefined, runs: ["Einstellungen", "\n", "pausiert"], sz: [1400, undefined, 1200] }
		])
		// The replacement ends selected.
		expect(next.selection.from).toBe(whole(next).from)
		expect(next.selection.to).toBe(whole(next).to)
	})

	it("pastes when the line count differs", () => {
		const { state, origins, body } = stateOf(bullets())
		const tr = replaceSlideText(state, whole(state), "One line only")

		expect(tr).not.toBeNull()

		const next = state.apply(tr ?? state.tr)

		expect(paragraphsOf(docToBody(next.doc, body, origins)).map(paragraph => paragraph.runs.join(""))).toEqual(["One line only"])
		expect(next.doc.textBetween(next.selection.from, next.selection.to)).toBe("One line only")
	})

	it("replaces part of one paragraph in place", () => {
		const { state } = stateOf(bullets())
		const from = 1 + "Revenue ".length
		const tr = replaceSlideText(state, { from, to: from + 2 }, "grew")
		const next = state.apply(tr ?? state.tr)

		expect(next.doc.firstChild?.textContent).toBe("Revenue grew 12 %")
		expect(next.doc.textBetween(next.selection.from, next.selection.to)).toBe("grew")
	})

	it("refuses a range holding a field or kept content", () => {
		const body: TextBody = {
			bodyPr: {},
			paragraphs: [{ pPr: {}, runs: [run("Slide "), { kind: "fld", type: "slidenum", id: "{1}", text: "3", rPr: {} }] }]
		}
		const { state } = stateOf(body)

		expect(slidePlainRange(state.doc, whole(state))).toBe(false)
		expect(replaceSlideText(state, whole(state), "Folie 3")).toBeNull()
		expect(bodyPlainText(body)).toBeNull()
		expect(replaceBodyText(body, "Folie 3")).toBeNull()
		// The text before the field alone is plain.
		expect(replaceSlideText(state, { from: 1, to: 6 }, "Folie")).not.toBeNull()
	})

	it("replaces a whole body's text, keeping its paragraphs' levels", () => {
		expect(bodyPlainText(bullets())).toBe("Revenue up 12 %\nCosts flat\nHiring\npaused")

		const next = replaceBodyText(bullets(), "A\nB\nC\nD")

		expect(next === null ? null : paragraphsOf(next).map(paragraph => paragraph.lvl)).toEqual([0, 1, 2])
	})
})

describe("a plain text body", () => {
	it("is one paragraph per line, with no properties", () => {
		expect(plainTextBody("First point.\r\nSecond point.\n")).toEqual({
			bodyPr: {},
			paragraphs: [
				{ pPr: {}, runs: [{ kind: "r", text: "First point.", rPr: {} }] },
				{ pPr: {}, runs: [{ kind: "r", text: "Second point.", rPr: {} }] },
				{ pPr: {}, runs: [] }
			]
		})
	})
})
