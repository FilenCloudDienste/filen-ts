import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { Region, type DocumentLayout } from "@filen/office/core/docx"
import { currentPageSetup, type PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { buildDocx, p } from "./docxSynthetic"
import { layOut, pageLines } from "./layoutFixtures"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

// Mirror margins (w:mirrorMargins, ECMA-376 Part 1 §17.15.1.57: "the left and right margins defined in the section
// properties shall be swapped on facing pages"): the left margin is the inside one, the right the outside one, and
// the gutter goes inside. Word's Mirrored preset: 1" top, bottom and outside, 1.25" inside.

const PX_PER_TWIP = 1 / 15
const LONG = Array.from({ length: 150 }, (_value, k) => p(`Paragraph ${String(k)} with some words to fill the line`)).join("")
const section = (left: number, right: number, gutter = 0): string =>
	`<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="${String(right)}" w:bottom="1440" w:left="${String(left)}" w:header="720" w:footer="720" w:gutter="${String(gutter)}"/></w:sectPr>`

// The left edge of the body's text on each page (px).
function bodyLefts(layout: DocumentLayout): number[] {
	return layout.pages.map(page =>
		Math.min(...pageLines(layout, page.index).flatMap(line => (line.region === Region.BODY ? [line.x] : [])))
	)
}

async function saved(editor: PagedEditor, opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<Uint8Array> {
	await settleAll(editor)

	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("no bytes")

	expect(pageDigest(editor.layout)).toEqual(await savedDigest(result.bytes))

	return result.bytes
}

const settingsXml = (bytes: Uint8Array): string => new TextDecoder().decode(unzipSync(bytes)["word/settings.xml"])

describe("mirror margins", () => {
	it("lays odd pages out with the inside margin and gutter on the left, even pages on the right", async () => {
		const layout = await layOut(buildDocx({ body: LONG + section(1800, 1440, 360), settings: "<w:mirrorMargins/>" }))
		const lefts = bodyLefts(layout)

		expect(lefts.length).toBeGreaterThanOrEqual(3)
		expect(lefts[0]).toBeCloseTo((1800 + 360) * PX_PER_TWIP, 1)
		expect(lefts[1]).toBeCloseTo(1440 * PX_PER_TWIP, 1)
		expect(lefts[2]).toBeCloseTo((1800 + 360) * PX_PER_TWIP, 1)

		// Without them every page has the left margin and gutter on the left.
		const plain = bodyLefts(await layOut(buildDocx({ body: LONG + section(1800, 1440, 360) })))

		expect(plain.slice(0, 3).map(left => Math.round(left))).toEqual([144, 144, 144])
	})

	it("sets Word's Mirrored margins with page.setup, read back, laid out and saved as Word does", async () => {
		const opened = await pagedEditor(buildDocx({ body: LONG + section(1440, 1440), settings: '<w:defaultTabStop w:val="720"/>' }))
		const { editor } = opened

		expect(currentPageSetup(editor).mirrorMargins).toBe(false)
		expect(
			await editor.execute({
				type: "page.setup",
				margins: { top: 1440, bottom: 1440, left: 1800, right: 1440 },
				mirrorMargins: true,
				scope: "document"
			})
		).toBe(true)
		expect(currentPageSetup(editor)).toMatchObject({ mirrorMargins: true, margins: { left: 1800, right: 1440 } })

		await settleAll(editor)

		const lefts = bodyLefts(editor.layout)

		expect(lefts[0]).toBeCloseTo(1800 * PX_PER_TWIP, 1)
		expect(lefts[1]).toBeCloseTo(1440 * PX_PER_TWIP, 1)
		expect(settingsXml(await saved(editor, opened))).toContain('<w:mirrorMargins/><w:defaultTabStop w:val="720"/>')

		// Only the switch: nothing else of the sections changes.
		expect(await editor.execute({ type: "page.setup", mirrorMargins: false })).toBe(true)
		expect(currentPageSetup(editor).mirrorMargins).toBe(false)
		await settleAll(editor)
		expect(bodyLefts(editor.layout)[1]).toBeCloseTo(1800 * PX_PER_TWIP, 1)
		expect(settingsXml(await saved(editor, opened))).not.toContain("mirrorMargins")

		// Undone, it is back on; asking for what is already set changes nothing.
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(currentPageSetup(editor).mirrorMargins).toBe(true)
		expect(await editor.execute({ type: "page.setup", mirrorMargins: true })).toBe(false)
		expect(settingsXml(await saved(editor, opened))).toContain('<w:mirrorMargins/><w:defaultTabStop w:val="720"/>')
		editor.dispose()
	})

	it("turns a document's own mirror margins off", async () => {
		const opened = await pagedEditor(buildDocx({ body: LONG + section(1800, 1440), settings: "<w:mirrorMargins/>" }))
		const { editor } = opened

		expect(currentPageSetup(editor).mirrorMargins).toBe(true)
		expect(await editor.execute({ type: "page.setup", mirrorMargins: false })).toBe(true)
		expect(settingsXml(await saved(editor, opened))).not.toContain("mirrorMargins")
		editor.dispose()
	})
})
