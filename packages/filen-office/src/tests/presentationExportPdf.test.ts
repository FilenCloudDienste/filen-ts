import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { standardSecurityKey } from "../core/pdfwrite/crypto"
import { fitBox, handoutPage, pageCount, type HandoutsPerPage } from "../core/presentation/pages"
import { JPEG_32x24 } from "./pdfWriteFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { deckPdf, installTestRealm, openDeck } from "./presentationExportFixtures"
import { installPresentationRealm, type RealmCanvas } from "../dom/presentation/services"
import { openPdf, pageText, structRoles } from "./docxPdfFixtures"

// Slides as a tagged PDF: text drawn and extractable, the structure (H1 title, list items, Figure with alt text,
// artifacts for layout art and footers), only http/https/mailto and slide links, picture bullets drawn, handouts in
// their grid, and a protected deck's PDF encrypted under its password.

const EMU = 9525
const TITLE = sp(2, "Title 1", 'type="title"', xfrm(100 * EMU, 40 * EMU, 760 * EMU, 80 * EMU), body(para("Quarterly results")))
// A JPEG passes through as it is (no decoder needed).
const PIXEL = JPEG_32x24

function pic(id: number, descr: string, rId: string): string {
	return (
		`<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="Picture ${String(id)}" descr="${descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
		`<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
		`<p:spPr>${xfrm(600 * EMU, 300 * EMU, 200 * EMU, 150 * EMU)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
	)
}

function bodyShape(paragraphs: string): string {
	return sp(3, "Content 2", 'idx="1"', xfrm(100 * EMU, 150 * EMU, 450 * EMU, 300 * EMU), body(paragraphs))
}

const LINKED =
	'<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId10"/></a:rPr><a:t>Read the report</a:t></a:r></a:p>' +
	'<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId11"/></a:rPr><a:t>Run me</a:t></a:r></a:p>' +
	'<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId12" action="ppaction://hlinksldjump"/></a:rPr><a:t>See appendix</a:t></a:r></a:p>'

function deck(): Uint8Array {
	return buildPptx({
		sldSz: '<p:sldSz cx="9144000" cy="5143500"/>',
		slides: [
			{
				shapes: TITLE + bodyShape(para("Revenue up") + para("Costs down")) + pic(5, "A rising chart", "rId9"),
				rels: [["rId9", "image", "../media/image1.jpeg"]]
			},
			{
				shapes: TITLE + bodyShape(LINKED),
				rels: [
					["rId10", "hyperlink", "https://example.com/report", "External"],
					["rId11", "hyperlink", "javascript:alert(1)", "External"],
					["rId12", "slide", "slide3.xml"]
				]
			},
			{ shapes: sp(2, "Title 1", 'type="title"', xfrm(100 * EMU, 40 * EMU, 760 * EMU, 80 * EMU), body(para("Appendix"))) }
		],
		parts: { "ppt/media/image1.jpeg": { data: PIXEL, type: "image/jpeg" } }
	})
}

async function annotations(pdf: pdfjs.PDFDocumentProxy, page: number): Promise<{ url?: string; dest?: unknown }[]> {
	return (await (await pdf.getPage(page)).getAnnotations()) as { url?: string; dest?: unknown }[]
}

beforeAll(() => {
	installTestRealm()
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("presentation PDF export", () => {
	it("writes one page per slide at the slide's size, its text extractable", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const { bytes } = await deckPdf(context)
		const pdf = await openPdf(bytes)

		expect(pdf.numPages).toBe(3)

		const [width, height] = (await pdf.getPage(1)).view.slice(2)

		// 9144000 x 5143500 EMU = 960 x 540 px = 720 x 405 pt.
		expect([width, height]).toEqual([720, 405])
		expect((await pageText(pdf, 1)).replace(/\s+/gu, " ")).toContain("Quarterly results")
		expect((await pageText(pdf, 1)).replace(/\s+/gu, "")).toContain("Revenueup")
	})

	it("tags the title H1, the body P, and a picture a Figure with its alt text", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const pdf = await openPdf((await deckPdf(context)).bytes)
		const roles = await structRoles(pdf, 1)

		expect(roles).toContain("Sect")
		expect(roles).toContain("H1")
		expect(roles).toContain("Figure")
		expect(roles.filter(role => role === "H1")).toHaveLength(1)

		const tree = JSON.stringify(await (await pdf.getPage(1)).getStructTree())

		expect(tree).toContain("A rising chart")
	})

	it("tags bulleted paragraphs as list items", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const roles = await structRoles(await openPdf((await deckPdf(context)).bytes), 1)

		expect(roles).toContain("L")
		expect(roles.filter(role => role === "LI")).toHaveLength(2)
	})

	it("links http(s) URLs and slide jumps, never another scheme", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const pdf = await openPdf((await deckPdf(context)).bytes)
		const links = await annotations(pdf, 2)

		expect(links.map(link => link.url).filter(url => url !== undefined)).toEqual(["https://example.com/report"])
		// The jump to slide 3 resolves to its page.
		const jump = links.find(link => link.dest !== undefined)

		expect(jump).toBeDefined()

		const dest = typeof jump?.dest === "string" ? await pdf.getDestination(jump.dest) : (jump?.dest as unknown[])
		const target = dest?.[0] as { num: number; gen: number }

		expect(await pdf.getPageIndex(target)).toBe(2)
		expect(JSON.stringify(links)).not.toContain("javascript")
	})

	it("drops a slide jump to a slide the export leaves out", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const refs = context.session.deck.slides.slice(0, 2)
		const pdf = await openPdf((await deckPdf(context, { refs })).bytes)

		expect((await annotations(pdf, 2)).filter(link => link.dest !== undefined)).toHaveLength(0)
	})

	it("draws a picture bullet's picture", { timeout: 60_000 }, async () => {
		const bullet =
			'<a:p><a:pPr marL="342900" indent="-342900"><a:buBlip><a:blip r:embed="rId9"/></a:buBlip></a:pPr><a:r><a:rPr lang="en-GB" sz="2400"/><a:t>Pictured</a:t></a:r></a:p>'
		const bytes = buildPptx({
			sldSz: '<p:sldSz cx="9144000" cy="5143500"/>',
			slides: [{ shapes: bodyShape(bullet), rels: [["rId9", "image", "../media/image1.jpeg"]] }],
			parts: { "ppt/media/image1.jpeg": { data: PIXEL, type: "image/jpeg" } }
		})
		const context = await openDeck(bytes)
		const pdf = await openPdf((await deckPdf(context)).bytes)
		const operators = await (await pdf.getPage(1)).getOperatorList()
		const images = operators.fnArray.filter(fn => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject)

		expect(images.length).toBe(1)
	})

	it("draws an SVG picture without a raster fallback from the realm's raster of it", { timeout: 60_000 }, async () => {
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>'
		)
		const bytes = buildPptx({
			sldSz: '<p:sldSz cx="9144000" cy="5143500"/>',
			slides: [{ shapes: pic(5, "A red square", "rId9"), rels: [["rId9", "image", "../media/image1.svg"]] }],
			parts: { "ppt/media/image1.svg": { data: svg, type: "image/svg+xml" } }
		})
		const asked: number[] = []
		const canvas: RealmCanvas = {
			canvas: (width, height) =>
				({
					width,
					height,
					close: () => undefined,
					getContext: () => ({
						drawImage: () => undefined,
						getImageData: (_x: number, _y: number, w: number, h: number) => ({
							width: w,
							height: h,
							data: new Uint8ClampedArray(w * h * 4).fill(255)
						})
					}),
					transferToImageBitmap: () => ({ width, height, close: () => undefined })
				}) as never,
			svg: (_bytes, side) => {
				asked.push(side)

				return Promise.resolve({ width: side, height: side, close: () => undefined })
			},
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
		const { bytes: pdfBytes, outcome } = await deckPdf(await openDeck(bytes), { canvas })
		const operators = await (await (await openPdf(pdfBytes)).getPage(1)).getOperatorList()

		// 200 px on the page, rasterised at 2 px per px, in 128 px steps.
		expect(asked).toEqual([512])
		expect(operators.fnArray.filter(fn => fn === pdfjs.OPS.paintImageXObject)).toHaveLength(1)
		expect(new TextDecoder("latin1").decode(pdfBytes)).toContain("/Width 512")
		expect(outcome.pdf?.refused ?? []).toEqual([])
	})

	it("lays handouts out in their grid: ceil(N / k) pages", { timeout: 60_000 }, async () => {
		const slides = Array.from({ length: 7 }, (_, index) => ({
			shapes: TITLE.replace("Quarterly results", `Slide ${String(index + 1)}`)
		}))
		const context = await openDeck(buildPptx({ slides }))

		for (const perPage of [3, 6] as const) {
			const pdf = await openPdf((await deckPdf(context, { layout: "handouts", perPage })).bytes)

			expect(pdf.numPages).toBe(Math.ceil(7 / perPage))
			expect((await pageText(pdf, 1)).replace(/\s+/gu, " ")).toContain("Slide 2")
		}
	})

	it("encrypts the PDF (AES-256) with a key made from the source's password", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const securityKey = await standardSecurityKey("tika")
		const { bytes } = await deckPdf(context, { securityKey })

		await expect(openPdf(bytes)).rejects.toThrow()

		const pdf = await openPdf(bytes, "tika")

		expect(pdf.numPages).toBe(3)
		expect(new TextDecoder("latin1").decode(bytes)).toContain("/V 5")
	})

	it("writes the same bytes for the same deck", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())

		expect((await deckPdf(context)).bytes).toEqual((await deckPdf(context)).bytes)
	})
})

describe("handout and notes page geometry", () => {
	const slide = { cx: 9144000, cy: 5143500 }
	const paper = { cx: 6858000, cy: 9144000 }

	it("places k slides per page row by row inside a half-inch margin", () => {
		const grid: Record<HandoutsPerPage, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 9: 9 }

		for (const perPage of [1, 2, 3, 4, 6, 9] as const) {
			const page = handoutPage(perPage, slide, paper)

			expect(page.slides).toHaveLength(grid[perPage])

			for (const box of page.slides) {
				expect(box.x).toBeGreaterThanOrEqual(48 - 1e-6)
				expect(box.y).toBeGreaterThanOrEqual(48 - 1e-6)
				expect(box.x + box.width).toBeLessThanOrEqual(page.width - 48 + 1e-6)
				expect(box.y + box.height).toBeLessThanOrEqual(page.height - 48 + 1e-6)
				// The slide's proportions kept.
				expect(box.width / box.height).toBeCloseTo(slide.cx / slide.cy, 6)
			}

			// Reading order: left to right, then down.
			const second = page.slides[1]
			const first = page.slides[0]

			if (first !== undefined && second !== undefined)
				expect(second.y > first.y + first.height - 1e-6 || (second.x > first.x && second.y === first.y)).toBe(true)
		}
	})

	it("rules notes lines beside each slide of the 3-per-page layout only", () => {
		expect(handoutPage(3, slide, paper).rules.every(rule => rule.ys.length > 0)).toBe(true)
		expect(handoutPage(6, slide, paper).rules).toHaveLength(0)
	})

	it("counts N pages for slides and notes, ceil(N / k) for handouts", () => {
		expect(pageCount(81)).toBe(81)
		expect(pageCount(81, 6)).toBe(14)
		expect(pageCount(81, 9)).toBe(9)
	})

	it("fits a slide into a box centred with its proportions", () => {
		expect(fitBox(16, 9, { x: 0, y: 0, width: 160, height: 160 })).toEqual({ x: 0, y: 35, width: 160, height: 90 })
	})
})
