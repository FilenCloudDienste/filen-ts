// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import {
	changeLevel,
	clearFormatting,
	insertLineBreak,
	pastedSlice,
	selectionRunProps,
	setBullet,
	setHyperlink,
	setRunProps,
	stepFontSize,
	steppedSize,
	tabKey,
	toggleBaseline,
	toggleRunFlag,
	toggleUnderline,
	DEFAULT_BULLET,
	DEFAULT_NUMBERING,
	type PastedElement,
	type TextCommand,
	type TextDefaults
} from "../core/presentation/edit/commands/text"
import type { TextBody } from "../core/presentation/model"
import { bodyToDoc, docToBody, presentationTextSchema } from "../core/presentation/text/schema"
import { safeClipboardHtml } from "../react/docx/edit/clipboard"

// The ribbon's and the keyboard's text commands over the editing schema: run properties on a selection (the word
// at a caret, the next typing otherwise), toggles that read what the inheritance chain shows, bullets and levels,
// links limited to the allowed schemes, and pasted HTML read back as paragraphs with the caret's formatting.

const BODY: TextBody = {
	bodyPr: {},
	paragraphs: [
		{ pPr: {}, runs: [{ kind: "r", text: "Hello world", rPr: { lang: "en-GB" } }] },
		{ pPr: { lvl: 1 }, runs: [{ kind: "r", text: "Second", rPr: { b: true } }] },
		{ pPr: {}, runs: [], endRPr: { sz: 2000 } }
	]
}

function state(body: TextBody = BODY, from?: number, to?: number): EditorState {
	const { doc } = bodyToDoc(body)
	const base = EditorState.create({ doc, schema: presentationTextSchema })

	return from === undefined ? base : base.apply(base.tr.setSelection(TextSelection.create(doc, from, to ?? from)))
}

function run(command: TextCommand, start: EditorState): EditorState {
	let next = start

	command(start, (tr: Transaction) => {
		next = start.apply(tr)
	})

	return next
}

function body(next: EditorState, source: TextBody = BODY): TextBody {
	const { origins } = bodyToDoc(source)

	return docToBody(next.doc, source, origins)
}

// Titles are bold by inheritance at level 0 in this chain.
const BOLD_TITLE: TextDefaults = { paragraph: level => (level === 0 ? { defRPr: { b: true, sz: 4400 } } : { defRPr: { sz: 2800 } }) }

describe("presentation text commands", () => {
	it("bold toggles off where the chain makes the text bold, and on where any run is not", () => {
		const off = run(toggleRunFlag("b", BOLD_TITLE), state(BODY, 1, 6))

		expect(body(off).paragraphs[0]?.runs).toEqual([
			{ kind: "r", text: "Hello", rPr: { lang: "en-GB", b: false } },
			{ kind: "r", text: " world", rPr: { lang: "en-GB" } }
		])

		// Across a non-bold and a bold run: everything bold.
		const on = run(toggleRunFlag("b"), state(BODY, 7, 17))

		expect(body(on).paragraphs[0]?.runs.at(-1)).toEqual({ kind: "r", text: "world", rPr: { lang: "en-GB", b: true } })
		expect(body(on).paragraphs[1]?.runs).toEqual([{ kind: "r", text: "Second", rPr: { b: true } }])
	})

	it("a caret inside a word formats the word; at a word's edge it formats what is typed next", () => {
		const word = run(toggleUnderline(), state(BODY, 3))

		expect(body(word).paragraphs[0]?.runs[0]).toEqual({ kind: "r", text: "Hello", rPr: { lang: "en-GB", u: "sng" } })

		const edge = run(setRunProps({ i: true }), state(BODY, 6))

		expect(edge.storedMarks?.[0]?.attrs["rPr"]).toEqual({ lang: "en-GB", i: true })
		expect(body(edge).paragraphs[0]?.runs).toHaveLength(1)
	})

	it("an empty paragraph's mark takes the format, so the line shows it", () => {
		const next = run(setRunProps({ sz: 3600 }), state(BODY, 22))

		expect(body(next).paragraphs[2]?.endRPr).toEqual({ sz: 3600 })
	})

	it("font size steps through PowerPoint's list from what the text shows", () => {
		expect(steppedSize(18, 1)).toBe(20)
		expect(steppedSize(10.5, -1)).toBe(10)
		expect(steppedSize(96, 1)).toBe(100)
		expect(steppedSize(8, -1)).toBe(1)

		const grown = run(stepFontSize(1, BOLD_TITLE), state(BODY, 1, 12))

		expect(body(grown).paragraphs[0]?.runs[0]).toEqual({ kind: "r", text: "Hello world", rPr: { lang: "en-GB", sz: 4800 } })
	})

	it("superscript sets PowerPoint's offset and toggles off; clear formatting keeps only the language", () => {
		const raised = run(toggleBaseline("super"), state(BODY, 1, 6))

		expect(body(raised).paragraphs[0]?.runs[0]).toEqual({ kind: "r", text: "Hello", rPr: { lang: "en-GB", baseline: 30_000 } })

		const back = run(toggleBaseline("super"), raised.apply(raised.tr.setSelection(TextSelection.create(raised.doc, 1, 6))))

		expect(body(back).paragraphs[0]?.runs[0]).toEqual({ kind: "r", text: "Hello world", rPr: { lang: "en-GB" } })

		const cleared = run(clearFormatting(), state(BODY, 1, 20))

		expect(body(cleared).paragraphs[1]?.runs).toEqual([{ kind: "r", text: "Second", rPr: {} }])
	})

	it("bullets toggle with PowerPoint's hanging indent, numbering replaces bullets, and off removes the indent", () => {
		const on = run(setBullet(DEFAULT_BULLET), state(BODY, 2))

		expect(body(on).paragraphs[0]?.pPr).toEqual({ bullet: DEFAULT_BULLET, marL: 342900, indent: -342900 })

		const numbered = run(setBullet(DEFAULT_NUMBERING), on.apply(on.tr.setSelection(TextSelection.create(on.doc, 2))))

		expect(body(numbered).paragraphs[0]?.pPr).toMatchObject({ bullet: DEFAULT_NUMBERING })

		const off = run(setBullet(DEFAULT_NUMBERING), numbered.apply(numbered.tr.setSelection(TextSelection.create(numbered.doc, 2))))

		expect(body(off).paragraphs[0]?.pPr).toEqual({ bullet: { kind: "none" }, marL: 0, indent: 0 })
	})

	it("levels go up and down within 0–8; Tab at a paragraph's start indents, inside it types a tab", () => {
		const down = run(changeLevel(1), state(BODY, 1))

		expect(body(down).paragraphs[0]?.pPr).toEqual({ lvl: 1 })

		const up = run(changeLevel(-1), state(BODY, 14))

		expect(body(up).paragraphs[1]?.pPr).toEqual({})

		const tabbed = run(tabKey(1), state(BODY, 4))

		expect(body(tabbed).paragraphs[0]?.runs[0]).toMatchObject({ text: "Hel\tlo world" })
		expect(changeLevel(-1)(state(BODY, 1))).toBe(false)
	})

	it("Shift+Enter puts a line break with the caret's properties", () => {
		const broken = run(insertLineBreak, state(BODY, 6))

		expect(body(broken).paragraphs[0]?.runs).toEqual([
			{ kind: "r", text: "Hello", rPr: { lang: "en-GB" } },
			{ kind: "br", rPr: { lang: "en-GB" } },
			{ kind: "r", text: " world", rPr: { lang: "en-GB" } }
		])
	})

	it("links take http, https, mailto and slides; other schemes are refused", () => {
		const linked = run(setHyperlink({ kind: "url", href: "https://filen.io" }), state(BODY, 1, 6))

		expect(body(linked).paragraphs[0]?.runs[0]).toEqual({
			kind: "r",
			text: "Hello",
			rPr: { lang: "en-GB", hlinkClick: { kind: "url", href: "https://filen.io" } }
		})
		expect(setHyperlink({ kind: "url", href: "javascript:alert(1)" })(state(BODY, 1, 6))).toBe(false)
		expect(setHyperlink({ kind: "url", href: "file:///etc/passwd" })(state(BODY, 1, 6))).toBe(false)

		const removed = run(setHyperlink(undefined), linked.apply(linked.tr.setSelection(TextSelection.create(linked.doc, 1, 6))))

		expect(body(removed).paragraphs[0]?.runs[0]).toEqual({ kind: "r", text: "Hello world", rPr: { lang: "en-GB" } })
	})

	it("reads the selection's shown format where the runs agree", () => {
		expect(selectionRunProps(state(BODY, 1, 6), BOLD_TITLE)).toMatchObject({ b: true, sz: 4400, lang: "en-GB" })
		expect(selectionRunProps(state(BODY, 1, 20), BOLD_TITLE)).not.toHaveProperty("sz")
	})

	it("pasted HTML is sanitized, then read as paragraphs with the caret's format plus b/i/u/s", () => {
		const safe = safeClipboardHtml('<p style="color:red">One <b>two</b><script>alert(1)</script></p><div><i>three</i><br>four</div>')
		const parsed = new DOMParser().parseFromString(`<body>${safe}</body>`, "text/html")
		const slice = pastedSlice(parsed.body as unknown as PastedElement, { sz: 2000 }, null)
		const start = state(BODY, 6)
		const pasted = start.apply(start.tr.replaceSelection(slice))
		const result = body(pasted)

		expect(result.paragraphs[0]?.runs).toEqual([
			{ kind: "r", text: "Hello", rPr: { lang: "en-GB" } },
			{ kind: "r", text: "One ", rPr: { sz: 2000 } },
			{ kind: "r", text: "two", rPr: { sz: 2000, b: true } }
		])
		expect(result.paragraphs[1]?.runs).toEqual([
			{ kind: "r", text: "three", rPr: { sz: 2000, i: true } },
			{ kind: "br", rPr: { sz: 2000 } },
			{ kind: "r", text: "four", rPr: { sz: 2000 } },
			{ kind: "r", text: " world", rPr: { lang: "en-GB" } }
		])
		expect(JSON.stringify(result)).not.toContain("alert")
	})
})
