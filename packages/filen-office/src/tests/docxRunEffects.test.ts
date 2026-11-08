import { describe, expect, it } from "vitest"
import { Emphasis, RunEffect, runEffectCss } from "../core/docx/layout/effects"
import { runCss } from "../core/docx/reflow/css"
import { MARK_ROOM } from "../core/text/index"
import { openPdf, pageText, pdfOf, snapshotOf } from "./docxPdfFixtures"
import { buildDocx } from "./docxSynthetic"
import { layOut, pageLines } from "./layoutFixtures"
import { inflatedStreams } from "./pdfWriteFixtures"

// Word's character effects (w:outline, w:shadow, w:emboss, w:imprint; ECMA-376 Part 1 §17.3.2.23, .31, .13, .18) and
// emphasis marks (w:em, §17.3.2.12) are drawn: the layout keeps room for the marks, the styles carry the effect and
// mark to the DOM, reflow and PDF painters.

const paragraph = (text: string, rPr = ""): string =>
	`<w:p><w:r>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe("character effects and emphasis marks", () => {
	it("resolves each effect once, emboss and imprint winning over outline and shadow", async () => {
		const layout = await layOut(
			buildDocx({
				body:
					paragraph("plain") +
					paragraph("outline", "<w:outline/>") +
					paragraph("shadow", "<w:shadow/>") +
					paragraph("both", "<w:outline/><w:shadow/>") +
					paragraph("emboss", "<w:emboss/><w:outline/><w:shadow/>") +
					paragraph("imprint", "<w:imprint/><w:shadow/>") +
					paragraph("dots", '<w:em w:val="dot"/>') +
					paragraph("under", '<w:em w:val="underDot"/>')
			})
		)
		const effects = new Set(layout.styleInfo.map(info => info.effect))
		const emphases = new Set(layout.styleInfo.map(info => info.emphasis))

		expect([...effects].sort()).toEqual([
			RunEffect.NONE,
			RunEffect.OUTLINE,
			RunEffect.SHADOW,
			RunEffect.OUTLINE_SHADOW,
			RunEffect.EMBOSS,
			RunEffect.IMPRINT
		])
		expect([...emphases].sort()).toEqual([Emphasis.NONE, Emphasis.DOT, Emphasis.UNDER_DOT])
	})

	it("keeps room above the line for marks over the text and below it for underDot", async () => {
		const lines = pageLines(
			await layOut(
				buildDocx({
					body:
						paragraph("Plain line") +
						paragraph("Dotted line", '<w:em w:val="dot"/>') +
						paragraph("Under line", '<w:em w:val="underDot"/>')
				})
			),
			0
		)
		const height = (text: string): number => {
			const line = lines.find(candidate => candidate.text.startsWith(text))

			if (line === undefined) throw new Error(`no line ${text}`)

			return line.bottom - line.top
		}
		const plain = height("Plain")

		expect(height("Dotted")).toBeCloseTo(plain * (1 + MARK_ROOM), 1)
		expect(height("Under")).toBeCloseTo(plain * (1 + MARK_ROOM), 1)
	})

	it("draws effects and marks as CSS in em of the run's font and colour", () => {
		expect(runEffectCss(RunEffect.NONE, Emphasis.NONE)).toBe("")
		expect(runEffectCss(RunEffect.OUTLINE, Emphasis.NONE)).toBe(
			"-webkit-text-fill-color:var(--fo-page-bg, #ffffff);-webkit-text-stroke:0.04em currentColor;"
		)
		expect(runEffectCss(RunEffect.SHADOW, Emphasis.NONE)).toBe("text-shadow:0.06em 0.06em 0 #808080;")
		expect(runEffectCss(RunEffect.EMBOSS, Emphasis.NONE)).toBe(
			"-webkit-text-fill-color:var(--fo-page-bg, #ffffff);text-shadow:-0.05em -0.05em 0 #d9d9d9,0.05em 0.05em 0 #808080;"
		)
		expect(runEffectCss(RunEffect.IMPRINT, Emphasis.NONE)).toBe(
			"-webkit-text-fill-color:var(--fo-page-bg, #ffffff);text-shadow:0.05em 0.05em 0 #d9d9d9,-0.05em -0.05em 0 #808080;"
		)
		expect(runEffectCss(RunEffect.NONE, Emphasis.DOT)).toBe("text-emphasis:filled dot;text-emphasis-position:over right;")
		expect(runEffectCss(RunEffect.NONE, Emphasis.UNDER_DOT)).toBe("text-emphasis:filled dot;text-emphasis-position:under right;")
		expect(runEffectCss(RunEffect.NONE, Emphasis.CIRCLE)).toContain("open circle")
		expect(runEffectCss(RunEffect.NONE, Emphasis.COMMA)).toContain("filled sesame")
	})

	it("draws them in the reflowed view too", async () => {
		const layout = await layOut(buildDocx({ body: paragraph("Shadow", "<w:shadow/>") + paragraph("Dots", '<w:em w:val="circle"/>') }))
		const css = layout.styleInfo.map(info => (info.run === undefined ? "" : runCss(info.run))).join("|")

		expect(css).toContain("text-shadow:0.06em")
		expect(css).toContain("text-emphasis:open circle")
	})

	it("exports the effects and marks to PDF, the text extracted once", async () => {
		const docx = buildDocx({
			body:
				paragraph("Hollow", "<w:outline/>") +
				paragraph("Shaded", "<w:shadow/>") +
				paragraph("Raised", "<w:emboss/>") +
				paragraph("Mark it", '<w:em w:val="dot"/>')
		})
		const document = await snapshotOf(docx)

		expect(document.styles.map(style => style.effect ?? 0).sort()).toEqual(
			expect.arrayContaining([RunEffect.OUTLINE, RunEffect.SHADOW, RunEffect.EMBOSS])
		)

		const marked = document.styles.find(style => style.emphasis === Emphasis.DOT)

		// The marks sit in the room over the ascent.
		expect(marked?.markY).toBeLessThan(-(marked?.size ?? 0) * 0.5)

		const { bytes } = await pdfOf(document)
		const text = await pageText(await openPdf(bytes), 1)
		const streams = inflatedStreams(bytes)

		for (const word of ["Hollow", "Shaded", "Raised", "Mark it"]) expect(text).toContain(word)
		// The copies under the glyphs (one shadow, two relief edges) read as nothing (ActualText ""), so readers that
		// honour it extract the text once (pdf.js does not).
		expect(streams.split("/ActualText <>>> BDC").length - 1).toBe(3)
		// The outline: fill and stroke (mode 2) in white and the run's colour.
		expect(streams).toMatch(/\b2 Tr\b/)
		expect(streams).toContain("1 1 1 rg")
		// Shadow and relief copies in grey; six dots (none over the space) as curves.
		expect(streams).toContain("0.502 0.502 0.502 rg")
		expect((streams.match(/ c\n/g) ?? []).length).toBeGreaterThanOrEqual(6 * 4)
	})

	it("leaves documents without effects as they were", async () => {
		const document = await snapshotOf(buildDocx({ body: paragraph("Plain") }))

		for (const style of document.styles) {
			expect(style.effect).toBeUndefined()
			expect(style.emphasis).toBeUndefined()
			expect(style.markY).toBeUndefined()
		}

		expect(inflatedStreams((await pdfOf(document)).bytes)).not.toMatch(/\b2 Tr\b/)
	})
})
