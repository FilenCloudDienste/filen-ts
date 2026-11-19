// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { FragmentFlag, FragmentKind } from "../core/text/index"
import { paintPage } from "../react/docx/paint/page"
import { ReflowView } from "../react/docx/reflow/view"
import { NUMBERING_PART } from "./docxEditFixtures"
import { FIXTURE_TABLES, fixturePage, paragraph, text } from "./docxPageFixture"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { buildDocx } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Caps and small caps are measured as String.prototype.toUpperCase() of their text, which no language tailors; the
// page draws them with CSS text-transform, which follows the content language: their spans carry a neutral one, so
// a Turkish page does not dot the capital I the layout measured without a dot.

afterEach(() => {
	document.documentElement.lang = ""
})

describe("caps on a page in another language", () => {
	it("gives caps and small caps spans a neutral language and keeps their text", () => {
		document.documentElement.lang = "tr"

		const page = fixturePage({
			sources: ["Title", "Small", "plain"],
			lines: [
				paragraph(100, 0, 5, [text(0, 5, 96, FragmentKind.TEXT | FragmentFlag.CAPS)]),
				paragraph(130, 1, 5, [text(0, 5, 96, FragmentKind.TEXT | FragmentFlag.SMALL_CAPS)]),
				paragraph(160, 2, 5)
			]
		})
		const painted = paintPage(page, { document, tables: FIXTURE_TABLES })
		const [caps, small, plain] = painted.texts.map(shown => shown.element)

		expect(caps?.getAttribute("lang")).toBe("")
		expect(caps?.style.textTransform).toBe("uppercase")
		expect(caps?.textContent).toBe("Title")

		// Small caps: the lower-case letters in the smaller face, upper-cased the same way.
		const lower = small?.querySelector("span")

		expect(lower?.getAttribute("lang")).toBe("")
		expect(lower?.style.textTransform).toBe("uppercase")
		expect(lower?.textContent).toBe("mall")
		expect(small?.textContent).toBe("Small")

		expect(plain?.hasAttribute("lang")).toBe(false)
		expect(small?.hasAttribute("lang")).toBe(false)
	})
})

const STYLES =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
	'<w:style w:type="paragraph" w:styleId="Head"><w:name w:val="Head"/><w:rPr><w:caps/></w:rPr></w:style></w:styles>'
const NUMBERING =
	'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
	'<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
const NUMBERED = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'

describe("caps in Mobile view in another language", () => {
	it("gives cased paragraphs, runs and list markers a neutral language, and no other", async () => {
		document.documentElement.lang = "tr"

		const run = (rPr: string, value: string): string => `<w:r><w:rPr>${rPr}</w:rPr><w:t>${value}</w:t></w:r>`
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					`<w:p><w:pPr><w:pStyle w:val="Head"/>${NUMBERED}</w:pPr><w:r><w:t>Title</w:t></w:r></w:p>` +
					`<w:p><w:pPr>${NUMBERED}</w:pPr>${run("", "plain ")}${run("<w:caps/>", "Caps")}${run("<w:smallCaps/>", "Small")}${run("<w:b/>", "bold")}</w:p>` +
					`<w:p><w:pPr>${NUMBERED}</w:pPr><w:r><w:t>Plain</w:t></w:r></w:p>`,
				parts: [
					{
						name: "word/styles.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
						data: STYLES
					},
					NUMBERING_PART(NUMBERING)
				],
				relationships: [
					{ id: "rIdS", type: "styles", target: "styles.xml" },
					{ id: "rIdN", type: "numbering", target: "numbering.xml" }
				]
			})
		)
		const scroller = document.createElement("div")

		scroller.className = "fo-docx-reflow"
		document.body.appendChild(scroller)

		const reflow = new ReflowView(editor, scroller, {
			label: "Document",
			readOnly: false,
			apple: false,
			onFind: undefined,
			marks: [],
			interactions: undefined,
			document: emptyDocxDocument()
		})

		try {
			const paragraphs = [...scroller.querySelectorAll<HTMLElement>(".fo-docx-reflow-p")]
			const [title, mixed, plain] = paragraphs

			expect(paragraphs).toHaveLength(3)
			expect(title?.getAttribute("lang")).toBe("")
			expect(title?.getAttribute("style")).toContain("text-transform: uppercase")
			expect(title?.textContent).toContain("Title")
			expect(mixed?.hasAttribute("lang")).toBe(false)
			expect(plain?.hasAttribute("lang")).toBe(false)

			// Runs: their text as the document has it, the cased ones in the neutral language.
			const spans = [...(mixed?.querySelectorAll<HTMLElement>("span[style]") ?? [])].filter(
				span => !span.classList.contains("fo-docx-reflow-marker")
			)
			const byText = new Map(spans.map(span => [span.textContent, span]))

			expect(byText.get("Caps")?.getAttribute("lang")).toBe("")
			expect(byText.get("Caps")?.getAttribute("style")).toContain("text-transform: uppercase")
			expect(byText.get("Small")?.getAttribute("lang")).toBe("")
			expect(byText.get("Small")?.getAttribute("style")).toContain("font-variant-caps: small-caps")
			expect(byText.get("bold")?.hasAttribute("lang")).toBe(false)

			// List markers take the paragraph mark's look: the cased paragraph's marker is cased.
			const markers = paragraphs.map(element => element.querySelector<HTMLElement>(".fo-docx-reflow-marker"))

			expect(markers.every(marker => marker !== null)).toBe(true)
			expect(markers[0]?.getAttribute("lang")).toBe("")
			expect(markers[1]?.hasAttribute("lang")).toBe(false)
			expect(markers[2]?.hasAttribute("lang")).toBe(false)
		} finally {
			reflow.destroy()
			scroller.remove()
		}
	})
})
