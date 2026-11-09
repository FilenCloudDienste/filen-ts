// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import type { DocumentLayout, PageDisplayList } from "@filen/office/core/docx"
import type { DocxPageData, DocxTextStyle } from "@filen/office/dom/docx"
import { paintPage, patchPage, type DocxDocument, type DocxTables } from "@filen/office/react/docx"
import { DOCX_MARK_LABELS, paintMarks } from "@filen/office/react/docx/editor"
import { runCss } from "../core/docx/reflow/css"
import { ReflowView, type ReflowViewOptions } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Word's formatting marks drawn over a painted page and in the reflowed view: every mark where Word puts it, in a
// layer of its own that leaves the painted text, and so the layout, as it was.

function pageData(page: PageDisplayList): DocxPageData {
	const text = page.text

	return {
		index: page.index,
		number: page.number,
		numberText: page.numberText,
		section: page.section,
		width: page.width,
		height: page.height,
		lineCount: text.lineCount,
		fragmentCount: text.fragmentCount,
		decorationCount: text.decorationCount,
		lineFloats: text.lineFloats,
		lineInts: text.lineInts,
		fragmentFloats: text.fragmentFloats,
		fragmentInts: text.fragmentInts,
		decorationFloats: text.decorationFloats,
		decorationInts: text.decorationInts,
		graphicCount: page.graphicCount,
		graphicFloats: page.graphicFloats,
		graphicInts: page.graphicInts,
		objectCount: 0,
		objectFloats: new Float32Array(0),
		objectInts: new Int32Array(0),
		objectKinds: new Uint8Array(0),
		sourceCount: page.sourceCount,
		sourceInts: page.sourceInts,
		sourceTexts: page.sourceTexts,
		sourceMarks: page.sourceMarks,
		linkCount: 0,
		linkInts: new Int32Array(0)
	}
}

function tablesOf(layout: DocumentLayout): DocxTables {
	const styles: DocxTextStyle[] = []

	for (let id = 0; id < layout.styles.count; id++) {
		const style = layout.styles.get(id)
		const run = layout.styleInfo[id]?.run

		styles.push({
			font: `400 ${String(Math.round(style.size))}px sans-serif`,
			smallCapsFont: "400 10px sans-serif",
			color: "",
			kerning: true,
			letterSpacing: 0,
			scaleX: 1,
			shift: 0,
			ascent: style.size * 0.8,
			descent: style.size * 0.2,
			revision: 0,
			...(run?.vanish === true ? { hidden: true as const } : {})
		})
	}

	return { styles, decorations: [], links: [] }
}

const MARGINS = '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const BODY =
	'<w:p><w:r><w:t xml:space="preserve">one two\u00a0three</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t><w:br/><w:t>next</w:t></w:r></w:p>' +
	'<w:p><w:r><w:t xml:space="preserve">visible </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r></w:p>' +
	`<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell("a")}${cell("b")}</w:tr></w:tbl>` +
	p("before break", `<w:sectPr>${MARGINS}</w:sectPr>`) +
	'<w:p><w:r><w:t>column</w:t><w:br w:type="column"/></w:r></w:p>' +
	`<w:sectPr>${MARGINS}<w:type w:val="oddPage"/></w:sectPr>`

const texts = (root: HTMLElement, selector: string): string[] => [...root.querySelectorAll(selector)].map(element => element.textContent)

afterEach(() => {
	document.body.replaceChildren()
})

describe("formatting marks on the pages", () => {
	it("draws Word's marks over the page, leaving the painted text as it was", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: BODY }))

		editor.setFormattingMarks(true)
		await editor.whenSettled()

		const layout = editor.layout
		const page = layout.pages[0]

		if (page === undefined) throw new Error("no page")

		const tables = tablesOf(layout)
		const painted = paintPage(pageData(page), { document, tables })
		const before = painted.root.innerHTML
		const layer = paintMarks(painted, { document, tables, labels: DOCX_MARK_LABELS })

		expect(painted.root.innerHTML).toBe(before)
		expect(layer.getAttribute("aria-hidden")).toBe("true")

		const ends = texts(layer, ".fo-docx-mark-end")

		// Paragraphs, the line break, the two cells and the row.
		expect(ends.filter(text => text === "¶")).toHaveLength(2)
		expect(ends.filter(text => text === "↵")).toHaveLength(1)
		expect(ends.filter(text => text === "¤")).toHaveLength(3)
		expect(texts(layer, ".fo-docx-mark-tab")).toEqual(["→"])
		expect(layer.querySelectorAll(".fo-docx-mark-space")).toHaveLength(3)
		expect(layer.querySelectorAll(".fo-docx-mark-nbsp")).toHaveLength(1)
		expect(texts(layer, ".fo-docx-mark-section .fo-docx-mark-label")).toEqual(["Section Break (Odd Page)"])
		expect(texts(layer, "[data-fo-hidden]")).toEqual(["hidden"])
		// Copies are never focusable or links.
		expect(layer.querySelector("[tabindex], [role]")).toBeNull()

		// Laid out again the same, the lines keep their marks.
		const again = pageData(page)
		const patched = patchPage(painted, again, { document, tables }).painted
		const kept = [...layer.children]

		paintMarks(patched, { document, tables, labels: DOCX_MARK_LABELS }, layer)
		expect([...layer.children]).toEqual(kept)

		// Other labels draw the line marks anew.
		paintMarks(patched, { document, tables, labels: { ...DOCX_MARK_LABELS, sectionOddPage: "Abschnittswechsel" } }, layer)
		expect(texts(layer, ".fo-docx-mark-section .fo-docx-mark-label")).toEqual(["Abschnittswechsel"])
		editor.dispose()
	})

	it("labels a column break on its line", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: BODY }))

		await editor.whenSettled()

		const layout = editor.layout
		const shown = layout.pages.map(page => {
			const tables = tablesOf(layout)

			return paintMarks(paintPage(pageData(page), { document, tables }), { document, tables, labels: DOCX_MARK_LABELS })
		})

		expect(shown.flatMap(layer => texts(layer, ".fo-docx-mark-break .fo-docx-mark-label"))).toEqual(["Column Break"])
		editor.dispose()
	})
})

describe("formatting marks in the reflowed view", () => {
	const options = (): ReflowViewOptions => ({
		label: "Document",
		readOnly: false,
		apple: false,
		onFind: undefined,
		marks: [],
		interactions: undefined,
		document: {
			status: "ready",
			info: undefined,
			pages: [],
			pageCount: 0,
			tables: { styles: [], decorations: [], links: [] },
			session: undefined,
			media: undefined,
			error: undefined
		} as unknown as DocxDocument
	})

	it("marks spaces, breaks and the section break while the editor shows them", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: BODY }))
		const scroller = document.createElement("div")

		scroller.className = "fo-docx-reflow"
		document.body.appendChild(scroller)

		const view = new ReflowView(editor, scroller, options())

		expect(scroller.dataset["foMarks"] !== undefined).toBe(false)
		expect(scroller.querySelector(".fo-docx-reflow-format-mark")).toBeNull()

		editor.setFormattingMarks(true)
		await editor.whenSettled()

		expect(scroller.dataset["foMarks"] !== undefined).toBe(true)
		expect(texts(scroller, ".fo-docx-reflow-format-mark").sort()).toEqual(["°", "·", "·", "·", "↵"].sort())
		expect(scroller.querySelector("[data-fo-section]")?.getAttribute("data-fo-section")).toBe("Section Break (Odd Page)")
		expect(scroller.querySelector("[data-fo-break]")?.getAttribute("data-fo-label")).toBe("Column Break")
		// Hidden text shows by the view's variables (the stylesheet sets them under data-fo-marks).
		const hidden = editor.layout.styleInfo.find(info => info.run?.vanish === true)?.run

		if (hidden === undefined) throw new Error("no hidden run")

		expect(runCss(hidden)).toContain("display: var(--fo-reflow-hidden, none); text-decoration: var(--fo-reflow-hidden-line, none)")

		editor.setFormattingMarks(false)
		await editor.whenSettled()
		expect(scroller.dataset["foMarks"] !== undefined).toBe(false)
		expect(scroller.querySelector(".fo-docx-reflow-format-mark")).toBeNull()

		view.destroy()
		editor.dispose()
	})
})
