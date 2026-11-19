import { EditorState, TextSelection } from "prosemirror-state"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { legacyText, type LegacyField } from "../../core/docx/forms/controls"
import { PagedGeometry } from "../../core/docx/paged/geometry"
import type * as TextCommands from "../../core/presentation/edit/commands/text"
import type * as TextSchema from "../../core/presentation/text/schema"
import { HitTester } from "../../core/text"
import { sessionOf } from "../docxEditFixtures"
import { buildDocx } from "../docxSynthetic"
import { editedLayout } from "../pagedFixtures"
import { budget, cpuMs } from "../timing"

// Hermes has no Intl.Segmenter: legacy text fields cut at w:maxLength with the fallback, which must agree with
// Intl.Segmenter's grapheme clusters on what documents hold. Change Case, double-tap word selection and the
// presentation caret have fallbacks of their own: they agree with Intl.Segmenter where both must, and differ
// (pinned here) on what the fallback does not model.

const FIELD: LegacyField = {
	type: "FORMTEXT",
	name: "Text1",
	enabled: true,
	checked: false,
	entries: [],
	result: 0,
	textType: "regular",
	maxLength: 1,
	format: null
}

const TEXTS = [
	"plain ascii",
	"e\u0301a\u0300\u0323b",
	"\u{1F44D}\u{1F3FD}x\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}y",
	"\u{1F1E9}\u{1F1EA}\u{1F1EB}\u{1F1F7}\u{1F1EE}",
	"1\uFE0F\u20E3#\uFE0F\u20E3",
	"\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} scot",
	"a\r\nb\nc",
	"\u0915\u094D\u0937\u0924\u094D\u0930\u093F\u092F \u0939\u093F\u0928\u094D\u0926\u0940",
	"\u09AC\u09BE\u0982\u09B2\u09BE \u0995\u09CD\u09B7",
	"\uD55C\uAD6D\uC5B4 \uD14D\uC2A4\uD2B8",
	"\u65E5\u672C\u8A9E\u306E\u30C6\u30AD\u30B9\u30C8",
	"\u{10000}\u{1F600}",
	"x\u200Cy\u200Dz",
	"\uFDFA \u0645\u0631\u062D\u0628\u0627",
	"a\u0308\u0308\u0308"
]

const Segmenter = Intl.Segmenter

function expected(text: string, count: number): string {
	let out = ""
	let taken = 0

	for (const { segment } of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		if (taken++ === count) break

		out += segment
	}

	return out
}

describe("legacy text maxLength without Intl.Segmenter", () => {
	beforeAll(() => {
		Reflect.deleteProperty(Intl, "Segmenter")
	})

	afterAll(() => {
		Reflect.set(Intl, "Segmenter", Segmenter)
	})

	it("cuts at the same grapheme boundaries as Intl.Segmenter", () => {
		expect(Reflect.get(Intl, "Segmenter")).toBeUndefined()

		for (const text of TEXTS) {
			for (let count = 1; count <= [...text].length + 1; count++) {
				expect(legacyText({ ...FIELD, maxLength: count }, text), `${JSON.stringify(text)} ${count}`).toBe(expected(text, count))
			}
		}
	})

	it("cuts a long run of viramas and marks in time linear in it", () => {
		// A virama, marks, then a letter joins a conjunct: a pattern trying that before the marks alone read every
		// virama's marks again, quadratic in the run.
		const text = `\u0915${"\u094D".repeat(40_000)}!`
		const started = cpuMs()

		expect(legacyText({ ...FIELD, maxLength: 1 }, text)).toBe(text.slice(0, -1))
		expect(cpuMs() - started).toBeLessThan(budget(250))
	})

	it("keeps a field without a limit whole and an empty text empty", () => {
		expect(legacyText({ ...FIELD, maxLength: 0 }, "e\u0301x")).toBe("e\u0301x")
		expect(legacyText({ ...FIELD, maxLength: 3 }, "")).toBe("")
		expect(legacyText({ ...FIELD, maxLength: 2, format: "UPPERCASE" }, "a\u{1F600}bc")).toBe("A\u{1F600}")
	})
})

// Runs `run` with Intl.Segmenter back in place.
async function withSegmenter<T>(run: () => Promise<T>): Promise<T> {
	Reflect.set(Intl, "Segmenter", Segmenter)

	try {
		return await run()
	} finally {
		Reflect.deleteProperty(Intl, "Segmenter")
	}
}

describe("word and caret fallbacks without Intl.Segmenter", () => {
	let commands: typeof TextCommands
	let schema: typeof TextSchema

	beforeAll(async () => {
		Reflect.deleteProperty(Intl, "Segmenter")
		// The presentation commands keep the grapheme segmenter they first find: a fresh module finds none.
		vi.resetModules()
		commands = await import("../../core/presentation/edit/commands/text")
		schema = await import("../../core/presentation/text/schema")
	})

	afterAll(() => {
		Reflect.set(Intl, "Segmenter", Segmenter)
	})

	it("title-cases Latin, accented and apostrophe words as Intl.Segmenter's word starts do", async () => {
		const texts = ["hello world", "\u00E9lan \u00FCber \u00E7a", "e\u0301te\u0301 na\u00EFve", "don't o\u2019clock", "4th x2y"]
		const titled = async (paragraphs: readonly string[]): Promise<string> => {
			const session = await sessionOf({
				body: paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("")
			})
			const doc = session.state.doc

			session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)))
			expect(session.execute({ type: "format.changeCase" })).toBe(true)

			return session.state.doc.textBetween(0, session.state.doc.content.size, "\n")
		}
		const expected = ["Hello World", "\u00C9lan \u00DCber \u00C7a", "E\u0301te\u0301 Na\u00EFve", "Don't O\u2019clock", "4th X2y"].join(
			"\n"
		)

		expect(Reflect.get(Intl, "Segmenter")).toBeUndefined()
		expect(await titled(texts)).toBe(expected)
		expect(await withSegmenter(() => titled(texts))).toBe(expected)
		// The fallback starts a word after an underscore; Intl.Segmenter joins the two.
		expect(await titled(["foo_bar"])).toBe("Foo_Bar")
	})

	it("selects the word around a position over punctuation, digits and an atom", async () => {
		// "Hello, world 42abc don't" + tab + "tail": the paragraph's content starts at 1.
		const edited = await editedLayout(
			buildDocx({
				body: '<w:p><w:r><w:t xml:space="preserve">Hello, world 42abc don\'t</w:t><w:tab/><w:t>tail</w:t></w:r></w:p>'
			})
		)
		const geometry = new PagedGeometry(
			edited.story,
			edited.index,
			{ page: index => edited.layout.pages[index] },
			new HitTester(edited.layout.styles)
		)
		const agreed: readonly (readonly [number, { from: number; to: number }])[] = [
			[3, { from: 1, to: 6 }],
			[10, { from: 8, to: 13 }],
			[16, { from: 14, to: 19 }],
			[27, { from: 26, to: 30 }]
		]

		for (const [pos, range] of agreed) expect(geometry.wordRange(pos), String(pos)).toEqual(range)

		await withSegmenter(async () => {
			for (const [pos, range] of agreed) expect(geometry.wordRange(pos), String(pos)).toEqual(range)
		})

		// The fallback stops at an apostrophe; Intl.Segmenter keeps "don't" whole.
		expect(geometry.wordRange(21)).toEqual({ from: 20, to: 23 })
	})

	it("steps the presentation caret one code point at a time in both directions", () => {
		const step = (text: string, at: number, direction: 1 | -1): number => {
			const { doc } = schema.bodyToDoc({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })
			const state = EditorState.create({ doc, schema: schema.presentationTextSchema, selection: TextSelection.create(doc, at) })
			let head = at

			commands.horizontalMove(
				direction,
				"char",
				false
			)(state, tr => {
				head = state.apply(tr).selection.head
			})

			return head
		}
		// "a", a surrogate pair, a BMP "\u00E9": the content starts at 1.
		const text = "a\u{1F600}\u00E9"

		expect([step(text, 1, 1), step(text, 2, 1), step(text, 4, 1)]).toEqual([2, 4, 5])
		expect([step(text, 5, -1), step(text, 4, -1), step(text, 2, -1)]).toEqual([4, 2, 1])
		// A combining mark is a step of its own without a segmenter.
		expect(step("e\u0301", 3, -1)).toBe(2)
		expect(step("e\u0301", 1, 1)).toBe(2)
	})
})
