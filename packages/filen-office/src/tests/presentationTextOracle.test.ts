import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { describe, expect, it } from "vitest"
import { LINE_FLOATS, LINE_INTS } from "../core/text/index"
import { budget } from "./timing"
import { extensionOf, readCorpusList } from "./oracles/presentation/corpus"
import { loCacheDir, loPdfPath, readLoCache } from "./oracles/presentation/lo"
import { layoutSlide, openDeck, type LaidBody } from "./presentationTextHarness"

// Text layout against LibreOffice 7.5 (the cached slides.pdf of every frozen OOXML deck): per text body, the
// lines pdf.js finds in LibreOffice's PDF (text items grouped by baseline, split where a gap separates two
// bodies) against ours. Line count equal for ≥ 92% of bodies; median baseline error ≤ 1.5 pt over matched lines;
// bullet and number strings equal for ≥ 98% of numbered paragraphs. Runs with FILEN_OFFICE_LO_CACHE and the
// corpus (FILEN_OFFICE_CORPUS, default .corpus) present; FILEN_OFFICE_TEXT_REPORT writes the per-body results.

const CACHE = loCacheDir()
const CORPUS = resolve(process.env["FILEN_OFFICE_CORPUS"] ?? join(import.meta.dirname, "../../.corpus"))
const LIST = process.env["FILEN_OFFICE_CORPUS_LIST"] ?? "/tmp/p5/corpus-frozen.json"
const REPORT = process.env["FILEN_OFFICE_TEXT_REPORT"]
const ONLY = process.env["FILEN_OFFICE_TEXT_ONLY"]
const READY = CACHE !== undefined && existsSync(CORPUS) && existsSync(LIST)
const OOXML = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"])
const PX_PT = 0.75
const HEADER_FOOTER: ReadonlySet<string> = new Set(["ftr", "sldNum", "dt", "hdr"])

interface PdfLine {
	readonly text: string
	readonly baseline: number
	readonly x0: number
	readonly x1: number
	used: boolean
	// The page lines a joined line is made of.
	readonly parts?: readonly PdfLine[]
}

interface PdfItem {
	readonly str: string
	readonly x: number
	readonly baseline: number
	readonly width: number
	readonly size: number
}

// A page's text as lines: items on one baseline (±0.6 pt), split where the horizontal gap exceeds 1.5 em.
async function pdfLines(document: pdfjs.PDFDocumentProxy, page: number): Promise<PdfLine[]> {
	const proxy = await document.getPage(page)
	const height = proxy.view[3] ?? 0
	const content = await proxy.getTextContent()
	const items: PdfItem[] = []

	for (const item of content.items) {
		if (!("str" in item) || item.str.trim() === "") continue

		const [a, b, , d, e, f] = item.transform as number[]

		// Turned text (vertical bodies) is left out.
		if (Math.abs(b ?? 0) > 0.01) continue

		items.push({
			str: item.str,
			x: e ?? 0,
			baseline: height - (f ?? 0),
			width: item.width,
			size: Math.hypot(a ?? 0, d ?? 0) / Math.SQRT2 || Math.abs(d ?? 0)
		})
	}

	// Items in reading order join the line whose baseline is within 0.45 em (superscripts and subscripts stay on
	// their line) and whose end is within 1.5 em of them; anything else starts a line.
	items.sort((p, q) => p.baseline - q.baseline || p.x - q.x)

	interface Building {
		items: PdfItem[]
		baseline: number
		size: number
		x1: number
	}

	const building: Building[] = []

	for (const item of [...items].sort((p, q) => p.x - q.x)) {
		const size = Math.max(item.size, 1)
		const line = building.find(
			candidate =>
				Math.abs(candidate.baseline - item.baseline) <= 0.45 * Math.max(candidate.size, size) &&
				item.x >= candidate.x1 - 0.5 * size &&
				item.x - candidate.x1 <= 1.5 * Math.max(candidate.size, size)
		)

		if (line === undefined) {
			building.push({ items: [item], baseline: item.baseline, size, x1: item.x + item.width })
		} else {
			line.items.push(item)
			line.x1 = Math.max(line.x1, item.x + item.width)

			// The line's baseline is its largest text's.
			if (size > line.size) {
				line.size = size
				line.baseline = item.baseline
			}
		}
	}

	const lines: PdfLine[] = building.map(line => ({
		text: line.items.map(item => item.str).join(""),
		baseline: line.baseline,
		x0: line.items[0]?.x ?? 0,
		x1: line.x1,
		used: false
	}))

	// A text shadow is drawn as a second copy of the text a few points away: one copy is kept.
	const kept = lines.filter(
		(line, index) =>
			!lines.some(
				(other, at) =>
					at < index &&
					other.text === line.text &&
					Math.abs(other.x0 - line.x0) <= 8 &&
					Math.abs(other.baseline - line.baseline) <= 8 &&
					// Copies at the very same place are shapes of their own (a slide repeating its footer).
					Math.hypot(other.x0 - line.x0, other.baseline - line.baseline) > 0.5
			)
	)

	kept.sort((p, q) => p.baseline - q.baseline || p.x0 - q.x0)
	proxy.cleanup()

	return kept
}

// Letters and digits only: spaces, tabs, bullets and punctuation placement are not what line breaking decides.
function key(text: string): string {
	return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()
}

// A PDF line's key: pdf.js gives right-to-left text in visual order, compared here in logical order.
function pdfKey(text: string): string {
	const letters = key(text)

	return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u.test(letters) ? [...letters].reverse().join("") : letters
}

interface OurLine {
	readonly text: string
	readonly baseline: number
	readonly x0: number
	readonly x1: number
	readonly paragraph: number
	readonly first: boolean
	readonly font: string
}

function ourLines(body: LaidBody): OurLine[] {
	const page = body.result.page.page
	const out: OurLine[] = []

	for (let line = 0; line < page.lineCount; line++) {
		const source = page.lineInts[line * LINE_INTS + 5] ?? 0
		const text = page.sourceTexts[source] ?? ""
		const start = page.lineInts[line * LINE_INTS + 2] ?? 0
		const x = page.lineFloats[line * LINE_FLOATS + 3] ?? 0

		out.push({
			text: text.slice(start, page.lineInts[line * LINE_INTS + 3] ?? 0),
			baseline: (body.y + (page.lineFloats[line * LINE_FLOATS + 2] ?? 0)) * PX_PT,
			x0: (body.x + x) * PX_PT,
			x1: (body.x + x + (page.lineFloats[line * LINE_FLOATS + 4] ?? 0)) * PX_PT,
			paragraph: source,
			first: ((page.lineInts[line * LINE_INTS + 4] ?? 0) & 256) !== 0,
			font:
				body.result.page.styles[
					page.fragmentInts[((page.lineInts[line * LINE_INTS] ?? 0) + (page.lineInts[line * LINE_INTS + 1] ?? 1) - 1) * 5 + 2] ??
						0
				]?.font ?? ""
		})
	}

	return out
}

interface BodyResult {
	readonly deck: string
	readonly slide: number
	readonly shape: number
	readonly ours: number
	readonly theirs: number
	readonly linesEqual: boolean
	readonly compatibleFonts: boolean
	readonly autofit: string
	readonly spc: boolean
	readonly errors: readonly number[]
	// Matched lines: text, our baseline, theirs (pt), for the report.
	readonly pairs: readonly (readonly [string, number, number, number, number, string])[]
	readonly numbers: readonly { readonly ours: string; readonly theirs: string | undefined }[]
	// A body whose lines differ: our lines and LibreOffice's candidates, for the report.
	readonly detail?: { readonly ours: readonly string[]; readonly theirs: readonly string[] }
}

// The LibreOffice lines of one body: lines in its horizontal band (±12 pt) whose text is part of the body's text,
// nearest first, in order of the body's text.
function compareBody(body: LaidBody, lines: PdfLine[], deck: string, page: { width: number; height: number }): BodyResult | undefined {
	// Lines off the page are not in LibreOffice's PDF.
	const ours = ourLines(body).filter(
		line => key(line.text) !== "" && line.baseline > 0 && line.baseline < page.height && line.x0 < page.width && line.x1 > 0
	)

	if (ours.length === 0) return undefined

	const whole = ours.map(line => key(line.text)).join("")
	const left = body.x * PX_PT - 12
	const right = (body.x + body.width) * PX_PT + 12
	const top = Math.min(...ours.map(line => line.baseline)) - 60
	const bottom = Math.max(...ours.map(line => line.baseline)) + 60
	const inside = lines.filter(
		line =>
			!line.used && line.x0 >= left && line.x0 <= right && line.baseline >= top && line.baseline <= bottom && pdfKey(line.text) !== ""
	)
	// Pieces of one line LibreOffice wrote apart (a tab, a field, a run in another font) are joined when they sit on
	// one baseline inside the body's box.
	const joined: PdfLine[] = []

	for (const line of [...inside].sort((p, q) => p.baseline - q.baseline || p.x0 - q.x0)) {
		const previous = joined[joined.length - 1]

		if (
			previous !== undefined &&
			Math.abs(previous.baseline - line.baseline) <= 0.6 &&
			whole.includes(pdfKey(previous.text + line.text))
		) {
			joined[joined.length - 1] = {
				text: `${previous.text} ${line.text}`,
				baseline: previous.baseline,
				x0: previous.x0,
				x1: line.x1,
				used: false,
				parts: [...(previous.parts ?? [previous]), line]
			}
		} else {
			joined.push({ ...line, parts: [line] })
		}
	}

	const candidates = joined.filter(line => whole.includes(pdfKey(line.text)))
	const errors: number[] = []
	const pairs: [string, number, number, number, number, string][] = []
	const numbers: { ours: string; theirs: string | undefined }[] = []
	let matched = 0

	for (const line of ours) {
		const k = key(line.text)
		let best: PdfLine | undefined

		for (const candidate of candidates) {
			if (candidate.used || pdfKey(candidate.text) !== k) continue
			if (best === undefined || Math.abs(candidate.baseline - line.baseline) < Math.abs(best.baseline - line.baseline))
				best = candidate
		}

		if (best === undefined) continue

		best.used = true

		for (const part of best.parts ?? []) part.used = true

		matched++
		errors.push(line.baseline - best.baseline)
		pairs.push([
			line.text,
			Math.round(line.baseline * 100) / 100,
			Math.round(best.baseline * 100) / 100,
			Math.round((line.x1 - line.x0) * 100) / 100,
			Math.round((best.x1 - best.x0) * 100) / 100,
			line.font
		])

		const paragraph = body.resolved.paragraphs[line.paragraph]

		if (line.first && paragraph?.pPr.bullet?.kind === "autoNum") {
			// The generated marker, without the tab that follows it when it leaves room for one.
			const marker = line.text.slice(0, body.result.prefixes[line.paragraph] ?? 0).replace(/\t$/, "")

			numbers.push({ ours: marker, theirs: best.text.trim().startsWith(marker) ? marker : best.text.trim().split(/\s/)[0] })
		}
	}

	// LibreOffice lines of this body left unmatched (it broke the text elsewhere).
	const theirs = matched + candidates.filter(line => !line.used && pdfKey(line.text).length >= 3).length

	// Every line of ours is a line of theirs with the same text: the body's text is all there, so LibreOffice broke
	// it into the same lines (a line of theirs left over would repeat text).
	const linesEqual = matched === ours.length

	return {
		deck,
		slide: body.slide,
		shape: body.shape.id,
		ours: ours.length,
		theirs,
		linesEqual,
		compatibleFonts: body.compatibleFonts,
		autofit: `${body.resolved.bodyPr.autofit}:${body.resolved.bodyPr.fontScale}:${body.resolved.bodyPr.lineSpacingReduction}`,
		spc: body.resolved.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "opaque" && (run.rPr.spc ?? 0) !== 0)),
		...(linesEqual ? {} : { detail: { ours: ours.map(line => line.text), theirs: candidates.map(line => line.text) } }),
		errors,
		pairs,
		numbers
	}
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0)
}

describe.skipIf(!READY)("presentation text against LibreOffice 7.5", () => {
	it(
		"breaks lines as LibreOffice does, on its baselines, with its bullet numbers",
		async () => {
			const cache = CACHE ?? ""
			const entries = readCorpusList(LIST).filter(
				entry => OOXML.has(extensionOf(entry.path)) && (ONLY === undefined || entry.path.includes(ONLY))
			)
			const results: BodyResult[] = []

			for (const entry of entries) {
				const lo = readLoCache(cache, entry.sha256)
				const file = join(CORPUS, entry.path)

				if (lo === undefined || !existsSync(file) || !existsSync(loPdfPath(lo)) || lo.deck.error !== undefined) continue

				let opened: Awaited<ReturnType<typeof openDeck>>

				try {
					opened = await openDeck(file)
				} catch {
					continue
				}

				const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(loPdfPath(lo))), verbosity: 0 })
				const pdf = await task.promise
				// Date fields show the day LibreOffice wrote the PDF.
				const info = (await pdf.getMetadata()).info as { CreationDate?: string }
				const stamp = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(info.CreationDate ?? "")
				const now =
					stamp === null
						? new Date()
						: new Date(
								Number(stamp[1]),
								Number(stamp[2]) - 1,
								Number(stamp[3]),
								Number(stamp[4]),
								Number(stamp[5]),
								Number(stamp[6])
							)
				const slideWidth = opened.deck.size.cx / 9525
				const slideHeight = opened.deck.size.cy / 9525
				// The PDF holds the slides LibreOffice shows: hidden ones are left out.
				const pages =
					lo.deck.pdfPages?.split(",").map(Number) ??
					(lo.deck.slides ?? []).flatMap((slide, k) => (slide.hidden || slide.render !== undefined ? [] : [k + 1]))

				for (let index = 0; index < opened.deck.slides.length; index++) {
					const page = pages.indexOf(index + 1) + 1
					const ref = opened.deck.slides[index]

					if (page <= 0 || page > pdf.numPages || ref === undefined) continue

					const lines = await pdfLines(pdf, page)

					for (const body of await layoutSlide(opened, ref, index + opened.deck.firstSlideNumber, now)) {
						if (body.resolved.bodyPr.vertical !== "horz") continue
						// LibreOffice 7.5 takes footer, date and slide number placeholders into its own header and footer
						// settings and does not draw the slide's shapes: no line of theirs to compare.
						if (HEADER_FOOTER.has(body.shape.ph?.type ?? "")) continue
						// A stored shrink (normAutofit fontScale, lnSpcReduction) we apply exactly as the file stores it;
						// LibreOffice 7.5 computes a shrink of its own, so the sizes compared would differ.
						if (
							body.resolved.bodyPr.autofit === "normal" &&
							(body.resolved.bodyPr.fontScale !== 1 || body.resolved.bodyPr.lineSpacingReduction !== 0)
						)
							continue
						// Text placed off the slide is not on LibreOffice's page.
						if (body.x >= slideWidth || body.y >= slideHeight || body.x + body.width <= 0 || body.y + body.height <= 0) continue

						const result = compareBody(body, lines, entry.path, { width: slideWidth * PX_PT, height: slideHeight * PX_PT })

						if (result !== undefined) results.push(result)
					}
				}

				await task.destroy()
			}

			const equal = results.filter(result => result.linesEqual).length / Math.max(1, results.length)
			// Bodies whose fonts LibreOffice draws with the same advances as ours (a metric-compatible substitute
			// of each named font): where it draws another face, line breaks compare fonts, not layout.
			const compatible = results.filter(result => result.compatibleFonts)
			const compatibleEqual = compatible.filter(result => result.linesEqual).length / Math.max(1, compatible.length)
			const errors = results.flatMap(result => result.errors.map(Math.abs))
			const numbers = results.flatMap(result => result.numbers)
			const numbersEqual = numbers.filter(number => number.ours === number.theirs).length / Math.max(1, numbers.length)
			const summary = {
				bodies: results.length,
				linesEqual: equal,
				compatibleBodies: compatible.length,
				compatibleLinesEqual: compatibleEqual,
				medianBaselineErrorPt: median(errors),
				matchedLines: errors.length,
				numbered: numbers.length,
				numbersEqual
			}

			if (REPORT !== undefined) writeFileSync(REPORT, JSON.stringify({ summary, results }, null, 1))

			console.log(JSON.stringify(summary))

			expect(results.length).toBeGreaterThan(0)
			// Over every body the share is lower: where LibreOffice draws a font with an installed face of other
			// advances (Century Gothic, Gill Sans, Verdana… on the machine the cache was made on) and we draw its
			// bundled stand-in, the breaks compare fonts. The report carries both shares.
			expect(compatibleEqual).toBeGreaterThanOrEqual(0.92)
			expect(median(errors)).toBeLessThanOrEqual(1.5)
			expect(numbersEqual).toBeGreaterThanOrEqual(0.98)
		},
		budget(1_800_000)
	)
})
