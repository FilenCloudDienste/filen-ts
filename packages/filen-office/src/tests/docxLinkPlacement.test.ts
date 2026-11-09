import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { Item, RevisionView } from "@filen/office/core/docx"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import { DocxEngine, type DocxEngineServices, type DocxEvent, type DocxLinkTarget, type DocxPageData } from "@filen/office/dom/docx"
import { crossReferenceTarget, paragraphLinks } from "../dom/docx/links"
import { buildDocx, modelOf, type SyntheticDocx } from "./docxSynthetic"

// Every character half an em wide.
const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

function services(): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => Promise.resolve(),
		sliceMs: Infinity
	}
}

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`

function field(instruction: string, result: string): string {
	return (
		'<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
		`<w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r>` +
		'<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
		run(result) +
		'<w:r><w:fldChar w:fldCharType="end"/></w:r>'
	)
}

const BOOKMARK = '<w:p><w:bookmarkStart w:id="0" w:name="Fig3"/>' + run("Figure 3") + '<w:bookmarkEnd w:id="0"/></w:p>'

interface Placed {
	readonly text: string
	readonly start: number
	readonly target: DocxLinkTarget | undefined
}

// The links of the first page as the text each covers, where it starts and its target.
async function placed(spec: SyntheticDocx): Promise<Placed[]> {
	const pages: DocxPageData[] = []
	const links: DocxLinkTarget[] = []
	const engine = new DocxEngine(bytesSource(buildDocx(spec)), services(), (event: DocxEvent) => {
		if (event.type !== "pages") return

		for (const page of event.pages) pages[page.index] = page

		links.push(...event.links)
	})

	await engine.run()

	const first = pages[0]

	if (first === undefined) return []

	return Array.from({ length: first.linkCount }, (_, k) => {
		const at = k * 4
		const start = first.linkInts[at + 1] ?? 0

		return {
			text: (first.sourceTexts[first.linkInts[at] ?? 0] ?? "").slice(start, first.linkInts[at + 2]),
			start,
			target: links[first.linkInts[at + 3] ?? -1]
		}
	})
}

describe("link placement", () => {
	it("puts a link on its own words when the same words come earlier in the paragraph", async () => {
		const links = await placed({
			body:
				"<w:p>" +
				run("Click here to read, or ") +
				'<w:hyperlink r:id="rIdLink">' +
				run("here") +
				"</w:hyperlink>" +
				run(" to download") +
				"</w:p>",
			relationships: [{ id: "rIdLink", type: "hyperlink", target: "https://example.com/file", external: true }]
		})

		expect(links).toEqual([
			{ text: "here", start: "Click here to read, or ".length, target: { kind: "external", href: "https://example.com/file" } }
		])
	})

	it("places a link field after the same words", async () => {
		const links = await placed({
			body: "<w:p>" + run("Mail Mail ") + field('HYPERLINK "mailto:a@b.c"', "Mail") + "</w:p>"
		})

		expect(links.map(link => [link.text, link.start])).toEqual([["Mail", "Mail Mail ".length]])
	})

	it("makes REF and PAGEREF fields with \\h links to their bookmark", async () => {
		const links = await placed({
			body:
				"<w:p>" +
				run("See ") +
				field("REF Fig3 \\h", "Figure 3") +
				run(" on page ") +
				field("PAGEREF Fig3 \\h", "1") +
				"</w:p>" +
				BOOKMARK
		})

		expect(links.map(link => [link.text, link.start, link.target])).toEqual([
			["Figure 3", 4, { kind: "internal", anchor: "Fig3" }],
			["1", "See Figure 3 on page ".length, { kind: "internal", anchor: "Fig3" }]
		])
	})

	it("leaves a cross-reference without \\h as plain text", async () => {
		const links = await placed({ body: "<w:p>" + run("See ") + field("REF Fig3", "Figure 3") + "</w:p>" + BOOKMARK })

		expect(links).toEqual([])
	})

	it("gives a TOC entry's PAGEREF \\h inside its hyperlink one range, not two", async () => {
		const links = await placed({
			body:
				'<w:p><w:hyperlink w:anchor="Fig3">' +
				run("Figure 3\t") +
				field("PAGEREF Fig3 \\h", "1") +
				"</w:hyperlink></w:p>" +
				BOOKMARK
		})

		expect(links.map(link => [link.text, link.target])).toEqual([["Figure 3\t1", { kind: "internal", anchor: "Fig3" }]])
	})
})

describe("crossReferenceTarget", () => {
	it("reads the bookmark of REF, PAGEREF and NOTEREF with \\h only", () => {
		expect(crossReferenceTarget("REF _Ref123 \\h")).toEqual({ kind: "internal", anchor: "_Ref123", tooltip: undefined })
		expect(crossReferenceTarget(" PAGEREF _Toc9 \\h ")).toEqual({ kind: "internal", anchor: "_Toc9", tooltip: undefined })
		expect(crossReferenceTarget("NOTEREF _Ref7 \\f \\H")).toEqual({ kind: "internal", anchor: "_Ref7", tooltip: undefined })
		expect(crossReferenceTarget("REF _Ref123 \\p")).toBeUndefined()
		expect(crossReferenceTarget("REF \\h")).toBeUndefined()
		expect(crossReferenceTarget("SEQ Figure \\h")).toBeUndefined()
	})
})

describe("paragraphLinks without a map", () => {
	it("leaves out a link whose words occur more than once rather than guess", async () => {
		const model = await modelOf({
			body:
				"<w:p>" +
				run("here and ") +
				'<w:hyperlink w:anchor="a">' +
				run("here") +
				"</w:hyperlink>" +
				run(", then ") +
				'<w:hyperlink w:anchor="b">' +
				run("there") +
				"</w:hyperlink></w:p>"
		})
		const part = model.parts[model.stories[0]?.part ?? -1]

		expect(part).toBeDefined()

		if (part === undefined) return

		const paragraph = part.kinds.indexOf(Item.Paragraph)
		const text = part.paragraphText(paragraph)

		expect(paragraphLinks(part, paragraph, text, RevisionView.Final).map(link => text.slice(link.start, link.end))).toEqual(["there"])
	})
})
