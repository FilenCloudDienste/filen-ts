import { existsSync } from "node:fs"
import type { Node } from "prosemirror-model"
import { NodeSelection, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { docxSchema, equationLatex, latexPreview, selectEquation, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import { hitObject, type PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { ommlToMathTree } from "@filen/office/core/math"
import { decodeUtf8, encodeUtf8, parseXml } from "@filen/office/core/xml"
import { equationTree } from "../core/docx/math/edit"
import { builtInStyleId } from "../core/docx/edit/formats"
import { OMML_ELEMENTS, mathChecks } from "../core/docx/write/checks/math"
import type { CheckInput, CheckedPart } from "../core/docx/write/checks/index"
import { partReader } from "../core/docx/model/reader"
import { ommlWithPrefix } from "../core/docx/write/atoms/math"
import { MAX_OMML_DEPTH } from "../core/math/ommlWriter"
import { openBytes } from "./docxEditFixtures"
import { NAMESPACES, buildDocx, p } from "./docxSynthetic"
import { SCHEMA_ARCHIVE, XMLLINT, schemaOracle } from "./fuzz/harness"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

const nodes = docxSchema.nodes
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
const MATH_FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'

// Word's binomial theorem as its equation gallery writes it (a source equation, display).
const SOURCE_EQUATION =
	"<w:p><m:oMathPara><m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>" +
	'<w:bookmarkStart w:id="7" w:name="inside"/><m:r><m:t>+1</m:t></m:r><w:bookmarkEnd w:id="7"/></m:oMath></m:oMathPara></w:p>'
const INLINE_EQUATION =
	'<w:p><w:r><w:t xml:space="preserve">Area </w:t></w:r><m:oMath><m:r><m:t>πr</m:t></m:r></m:oMath><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>'

function docx(body: string, namespaces = NAMESPACES): Uint8Array {
	return buildDocx({
		document: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${namespaces}><w:body>${body}</w:body></w:document>`
	})
}

// The document element without the math namespace on its root (as LibreOffice and generators write it).
const WITHOUT_MATH = NAMESPACES.replace(`xmlns:m="${M}" `, "")

async function run(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	const result = await editor.execute(command)

	await settleAll(editor)

	return result
}

function caret(editor: PagedEditor, pos: number): void {
	editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, pos)))
}

function maths(doc: Node): { readonly node: Node; readonly pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos) => {
		if (node.type === nodes.math) out.push({ node, pos })
	})

	return out
}

async function saveOf(editor: PagedEditor, opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<Uint8Array> {
	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("No bytes")

	return result.bytes
}

async function documentXml(bytes: Uint8Array): Promise<string> {
	const opened = await openBytes(bytes)

	return decodeUtf8(await opened.pkg.opc.read("word/document.xml"))
}

async function sameLayout(editor: PagedEditor, bytes: Uint8Array): Promise<void> {
	await settleAll(editor)
	expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))
}

// The LaTeX of every equation of a saved file, in order.
async function savedLatex(bytes: Uint8Array): Promise<string[]> {
	const opened = await pagedEditor(bytes)

	return maths(opened.editor.session.state.doc).map(found => equationLatex(opened.editor.session, found.pos)?.latex ?? "")
}

describe("equation.insert", () => {
	it("inserts an inline equation at the caret, written as OMML under the root's prefix and laid out as saved", async () => {
		const bytes = docx(p("Before after"))
		const opened = await pagedEditor(bytes)
		const editor = opened.editor

		caret(editor, 8)
		expect(editor.canExecute("equation.insert")).toBe(true)
		expect(await run(editor, { type: "equation.insert", latex: "\\frac{a}{b}", display: false })).toBe(true)

		const found = maths(editor.session.state.doc)

		expect(found).toHaveLength(1)
		expect(found[0]?.node.attrs).toMatchObject({ src: -1, display: false })

		const saved = await saveOf(editor, opened)
		const xml = await documentXml(saved)

		expect(xml).toContain("Before <")
		// Word's math font (and the caret's formatting) on every run and on the fraction bar.
		expect(xml).toContain(
			`<m:oMath><m:f><m:fPr><m:ctrlPr>${MATH_FONT}</m:ctrlPr></m:fPr><m:num><m:r>${MATH_FONT}<m:t>a</m:t></m:r></m:num><m:den><m:r>${MATH_FONT}<m:t>b</m:t></m:r></m:den></m:f></m:oMath>`
		)
		expect(xml).not.toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f>')
		await sameLayout(editor, saved)
		expect(await savedLatex(saved)).toEqual(["\\frac{a}{b}"])
	})

	it("puts a display equation in a paragraph of its own, splitting the text around the caret", async () => {
		const opened = await pagedEditor(docx(p("Left right")))
		const editor = opened.editor

		caret(editor, 5)
		expect(await run(editor, { type: "equation.insert", latex: "x^2 \\\\ y", display: true })).toBe(true)

		const doc = editor.session.state.doc

		expect(doc.childCount).toBe(3)
		expect(doc.child(0).textContent).toBe("Left")
		expect(doc.child(1).childCount).toBe(1)
		expect(doc.child(1).firstChild?.type).toBe(nodes.math)
		expect(doc.child(1).firstChild?.attrs["display"]).toBe(true)
		expect(doc.child(2).textContent).toBe(" right")

		const saved = await saveOf(editor, opened)

		expect(await documentXml(saved)).toContain("<m:oMathPara><m:oMath>")
		await sameLayout(editor, saved)
		expect(await savedLatex(saved)).toEqual(["x^2 \\\\ y"])
	})

	it("declares the math namespace on the equation where the part's root does not", async () => {
		const opened = await pagedEditor(docx(p("Text"), WITHOUT_MATH))
		const editor = opened.editor

		caret(editor, 3)
		expect(await run(editor, { type: "equation.insert", latex: "\\sqrt{2}", display: false })).toBe(true)

		const saved = await saveOf(editor, opened)
		const xml = await documentXml(saved)

		expect(xml).toContain(`<m:oMath xmlns:m="${M}"><m:rad>`)
		await sameLayout(editor, saved)
		expect(await savedLatex(saved)).toEqual(["\\sqrt{2}"])
	})

	it("defines a style a command added while only a new equation's runs name it", async () => {
		const opened = await pagedEditor(docx(p("Before after")))
		const editor = opened.editor
		const style = builtInStyleId(opened.context, "Placeholder Text")

		editor.dispatch(editor.session.state.tr.addMark(1, 7, docxSchema.marks.char_style.create({ styleId: style })))
		caret(editor, 4)
		expect(await run(editor, { type: "equation.insert", latex: "x", display: false })).toBe(true)
		// The text that had the style loses it: only the equation (the caret's formatting) names it now.
		editor.dispatch(editor.session.state.tr.removeMark(0, editor.session.state.doc.content.size, docxSchema.marks.char_style))
		await settleAll(editor)
		expect([...editor.session.missingStyles]).toEqual([[style, "Placeholder Text"]])

		const saved = await saveOf(editor, opened)
		const styles = decodeUtf8(await (await openBytes(saved)).pkg.opc.read("word/styles.xml"))

		expect(await documentXml(saved)).toContain(`<w:rStyle w:val="${style}"/>`)
		expect(styles).toContain(`w:styleId="${style}"`)
		await sameLayout(editor, saved)
	})

	it("refuses LaTeX the subset cannot read", async () => {
		const opened = await pagedEditor(docx(p("Text")))

		caret(opened.editor, 2)
		expect(await run(opened.editor, { type: "equation.insert", latex: "\\frac{1}", display: false })).toBe(false)
		expect(maths(opened.editor.session.state.doc)).toHaveLength(0)
	})

	it("is undone whole, and the undone document saves as the file was", async () => {
		const bytes = docx(p("One") + INLINE_EQUATION)
		const opened = await pagedEditor(bytes)
		const editor = opened.editor

		caret(editor, 2)
		expect(await run(editor, { type: "equation.insert", latex: "a+b", display: true })).toBe(true)
		expect(await run(editor, { type: "history.undo" })).toBe(true)

		const saved = await saveOf(editor, opened)

		expect(await documentXml(saved)).toBe(await documentXml(bytes))
	})

	it("records nothing while changes are tracked without an author's name (it is asked for first)", async () => {
		const opened = await pagedEditor(docx(p("Text") + SOURCE_EQUATION))
		const editor = opened.editor
		const before = editor.session.state.doc

		caret(editor, 2)
		editor.session.context.review.tracking = true
		editor.session.context.identity.author = undefined
		expect(await run(editor, { type: "equation.insert", latex: "x", display: false })).toBe(false)
		expect(selectEquation(editor.session, maths(editor.session.state.doc)[0]?.pos ?? -1)).toBe(true)
		expect(await run(editor, { type: "equation.edit", latex: "y" })).toBe(false)
		expect(editor.session.state.doc.eq(before)).toBe(true)
	})
})

describe("equation.edit", () => {
	it("gives a source equation new OMML, keeping the markers it held, and reads back as written", async () => {
		const bytes = docx(p("Text") + SOURCE_EQUATION)
		const opened = await pagedEditor(bytes)
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		expect(equationLatex(editor.session, pos)).toEqual({ latex: "x^2+1", lossy: false, display: true })
		expect(selectEquation(editor.session, pos)).toBe(true)
		expect(editor.snapshot().context.equation).toMatchObject({ latex: "x^2+1", lossy: false, display: true, pos })
		// The same LaTeX: nothing changes.
		expect(await run(editor, { type: "equation.edit", latex: "x^2+1" })).toBe(true)
		expect(editor.session.state.doc.nodeAt(pos)?.attrs["omml"]).toBeNull()
		expect(await run(editor, { type: "equation.edit", latex: "\\alpha^2+1" })).toBe(true)
		expect(editor.session.state.selection).toBeInstanceOf(NodeSelection)

		const saved = await saveOf(editor, opened)
		const xml = await documentXml(saved)

		// The bookmark it held stays where it was, inside it.
		expect(xml).toMatch(
			/<\/m:sSup><w:bookmarkStart w:id="7" w:name="inside"\/><m:r>(<w:rPr>.*?<\/w:rPr>)?<m:t>\+1<\/m:t><\/m:r><w:bookmarkEnd w:id="7"\/>/
		)
		expect(xml).toContain("<m:t>α</m:t>")
		await sameLayout(editor, saved)
		expect(await savedLatex(saved)).toEqual(["\\alpha^2+1"])

		// Undone, the file's own bytes again.
		expect(await run(editor, { type: "history.undo" })).toBe(true)
		expect(await documentXml(await saveOf(editor, opened))).toBe(await documentXml(bytes))
	})

	it("needs the equation selected", async () => {
		const opened = await pagedEditor(docx(p("Text") + SOURCE_EQUATION))

		caret(opened.editor, 2)
		expect(opened.editor.canExecute("equation.edit")).toBe(false)
		expect(opened.editor.snapshot().context.equation).toBeNull()
	})

	it("keeps the snapshot's equation while the selection does not change", async () => {
		const opened = await pagedEditor(docx(p("Text") + INLINE_EQUATION))
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		selectEquation(editor.session, pos)

		const first = editor.snapshot().context.equation

		expect(first).toMatchObject({ latex: "\\pi r", display: false, lossy: false })
		expect(editor.snapshot().context.equation).toBe(first)
	})
})

describe("equations on the pages", () => {
	it("finds an equation under a page point, with its box", async () => {
		const opened = await pagedEditor(docx(p("Text") + INLINE_EQUATION))
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		await settleAll(editor)

		const rect = editor.rangeRects(pos, pos + 1, 0)[0]

		expect(rect).toBeDefined()

		const hit = hitObject(editor, 0, (rect?.x ?? 0) + (rect?.width ?? 0) / 2, (rect?.y ?? 0) + (rect?.height ?? 0) / 2)

		expect(hit).toMatchObject({ kind: "equation", pos })
		expect(hitObject(editor, 0, 1, 1)?.kind).not.toBe("equation")
	})

	it("paints a new equation as its preview showed it", async () => {
		const opened = await pagedEditor(docx(p("Text")))
		const editor = opened.editor

		caret(editor, 2)
		await run(editor, { type: "equation.insert", latex: "\\sum_{i=1}^n i", display: false })

		const found = maths(editor.session.state.doc)[0]

		expect(found).toBeDefined()
		expect(equationTree(found?.node as Node, editor.session.story.part)).toEqual(latexPreview("\\sum_{i=1}^n i", false).tree)

		// The page's object is the written XML read back.
		const saved = await saveOf(editor, opened)
		const xml = parseXml(encodeUtf8(await documentXml(saved)))
		let math = -1

		for (let node = 0; node < xml.count && math < 0; node++) if (xml.kinds[node] === 1 && xml.name(node) === "m:oMath") math = node

		expect(ommlToMathTree(xml, math)).toEqual(latexPreview("\\sum_{i=1}^n i", false).tree)
	})
})

// ---- gate 2 -------------------------------------------------------------------------------------------------

function checkedPart(inner: string, root = NAMESPACES): CheckedPart {
	const document = parseXml(encodeUtf8(`<w:document ${root}><w:body><w:p>${inner}</w:p></w:body></w:document>`))

	return { name: "word/document.xml", part: sourcePart(), document, skeleton: true }
}

// The source part a checked skeleton stands in (what its copies are of): `body`'s.
function sourcePart(body = ""): CheckedPart["part"] {
	const document = parseXml(encodeUtf8(`<w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`))

	return { document, reader: partReader(document) } as unknown as CheckedPart["part"]
}

const INPUT = { original: { has: () => true }, context: { model: { strict: false } } } as unknown as CheckInput

async function gate(inner: string, root?: string): Promise<string | undefined> {
	try {
		for (const check of mathChecks) await check.part?.(INPUT, checkedPart(inner, root))

		return undefined
	} catch (error) {
		return (error as Error).message
	}
}

describe("gate 2 on written equations", () => {
	it("passes what the writer writes, under any prefix", async () => {
		const omml =
			'<m:oMath><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num><m:r><m:t xml:space="preserve"> a</m:t></m:r></m:num><m:den/></m:f></m:oMath>'

		expect(await gate(omml)).toBeUndefined()
		expect(await gate(ommlWithPrefix(omml, "mm", M, true), WITHOUT_MATH)).toBeUndefined()
		expect(await gate("<m:oMath><m:r><w:rPr><w:b/></w:rPr><m:t>x</m:t></m:r></m:oMath>")).toBeUndefined()
	})

	it("refuses an element Office Math does not have", async () => {
		expect(OMML_ELEMENTS.has("mathPr")).toBe(false)
		expect(await gate("<m:oMath><m:frac/></m:oMath>")).toMatch(/does not have/)
		expect(await gate("<m:oMath><m:mathPr/></m:oMath>")).toMatch(/does not have/)
	})

	it("refuses another namespace, inside an equation or for its own", async () => {
		expect(await gate('<m:oMath><x:script xmlns:x="urn:x"/></m:oMath>')).toMatch(/another vocabulary/)
		expect(await gate('<s:oMath xmlns:s="http://purl.oclc.org/ooxml/officeDocument/math"/>')).toMatch(/another math namespace/)
		expect(await gate('<m:oMath xmlns:w="urn:x"/>')).toMatch(/declares another namespace/)
		expect(await gate('<m:oMath><m:r m:sty="p" w:rsidR="00"><m:t>x</m:t></m:r></m:oMath>')).toMatch(/has attribute/)
		expect(await gate("<m:r><m:t>x</m:t></m:r>")).toMatch(/does not start/)
	})

	it("refuses an equation deeper than readers read", async () => {
		const deep = (levels: number): string => "<m:oMath>" + "<m:d><m:e>".repeat(levels) + "</m:e></m:d>".repeat(levels) + "</m:oMath>"

		expect(await gate(deep(Math.floor(MAX_OMML_DEPTH / 2) - 1))).toBeUndefined()
		expect(await gate(deep(Math.floor(MAX_OMML_DEPTH / 2) + 1))).toMatch(/too deep/)
	})

	it("checks only the save's own markup of a source part", async () => {
		const part = checkedPart("<m:oMath><m:frac/></m:oMath>")

		expect(() => mathChecks[0]?.part?.(INPUT, { ...part, skeleton: false })).not.toThrow()
	})
})

describe.skipIf(!XMLLINT || !existsSync(SCHEMA_ARCHIVE))("written equations against the ECMA-376 schemas", () => {
	it("adds no validity errors", { timeout: 120_000 }, async () => {
		const validate = schemaOracle()
		const bytes = docx(p("Text one") + p("Text two") + SOURCE_EQUATION)
		const opened = await pagedEditor(bytes)
		const editor = opened.editor
		const latex = [
			"\\frac{a}{b}+\\sqrt[3]{x}+x_1^2+\\sum_{i=1}^{n}i",
			"\\left( a \\middle| b \\right)+\\begin{pmatrix} 1 & 2 \\\\ 3 \\end{pmatrix}+\\begin{cases} x & y \\\\ z & w \\end{cases}",
			"\\hat{x}+\\overline{y}+\\underbrace{a}_{n}+\\overset{a}{b}+\\lim_{x\\to 0}\\sin x+\\log_2 x+\\mathbb{R}+\\text{if }+\\binom{n}{k}"
		]

		caret(editor, 3)
		expect(await run(editor, { type: "equation.insert", latex: latex[0] ?? "", display: false })).toBe(true)
		caret(editor, editor.session.state.doc.child(0).nodeSize + 3)
		expect(await run(editor, { type: "equation.insert", latex: `${latex[1] ?? ""} \\\\ ${latex[2] ?? ""}`, display: true })).toBe(true)

		const source = maths(editor.session.state.doc).find(found => found.node.attrs["src"] !== -1)

		selectEquation(editor.session, source?.pos ?? -1)
		expect(await run(editor, { type: "equation.edit", latex: latex[2] ?? "" })).toBe(true)

		const saved = await saveOf(editor, opened)
		const before = validate(encodeUtf8(await documentXml(bytes)))
		const after = validate(encodeUtf8(await documentXml(saved)))

		expect([...after].filter(([message, count]) => (before.get(message) ?? 0) < count)).toEqual([])
		expect(maths(editor.session.state.doc)).toHaveLength(3)
	})
})
