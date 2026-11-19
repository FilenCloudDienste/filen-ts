import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { Item, modelStats, type DocumentLayout, type LayoutOptions, type StyleSettings } from "@filen/office/core/docx"
import {
	SUBSTITUTIONS,
	bundledFace,
	verticalMetrics,
	type FontManager,
	type FontRequest,
	type ResolvedFont
} from "@filen/office/core/fonts"
import { CORPUS_DIR } from "./corpusDir"
import { DocxRefusedError, adjustedFonts, layOut, layoutDigest, readBytes } from "./layoutFixtures"

// Page breaks Word recorded (w:lastRenderedPageBreak) against ours, on Word-authored files whose recorded
// breaks agree with docProps/app.xml <Pages> (the corpus README's page-count ground truth). Widths come from
// the bundled fonts' advance widths, so the comparison is deterministic and needs no browser.
//
// FILEN_OFFICE_LAYOUT_SWEEP=1 also runs the calibration variants and prints their agreement.

const DIRECTORY = join(CORPUS_DIR, "docx")
const present = existsSync(DIRECTORY)

interface Truth {
	readonly name: string
	readonly bytes: Uint8Array
	readonly pages: number
	readonly breaks: number
	readonly minorFont: string
}

// Which files count: "corrected" (the ground truth) those whose recorded breaks agree with <Pages> and with
// their own page references; "pages" those agreeing with <Pages> only (the definition before page references
// were checked, kept to track the files it adds); "loose" every Word-authored file with recorded breaks.
type TruthSet = "corrected" | "pages" | "loose"

function groundTruth(set: TruthSet = "corrected"): Truth[] {
	const loose = set === "loose"

	const out: Truth[] = []

	for (const name of readdirSync(DIRECTORY).sort()) {
		if (!name.endsWith(".docx")) continue

		const bytes = readBytes(join(DIRECTORY, name))
		let files: Record<string, Uint8Array>

		try {
			files = unzipSync(bytes, {
				filter: file =>
					file.name === "docProps/app.xml" || file.name === "word/document.xml" || file.name === "word/theme/theme1.xml"
			})
		} catch {
			continue
		}

		const app = files["docProps/app.xml"]
		const document = files["word/document.xml"]

		if (app === undefined || document === undefined) continue

		const appXml = strFromU8(app)

		if (!/<Application>Microsoft (Office|Macintosh) Word/.test(appXml)) continue

		const pages = Number(/<Pages>(\d+)<\/Pages>/.exec(appXml)?.[1] ?? "NaN")
		const breaks = (strFromU8(document).match(/<w:lastRenderedPageBreak\/>/g) ?? []).length

		if (loose ? breaks === 0 : !(pages === breaks + 1) || pages < 2 || (set === "corrected" && !pageRefsAgree(strFromU8(document))))
			continue

		const theme = files["word/theme/theme1.xml"]
		const minorFont = theme === undefined ? "" : (/<a:minorFont><a:latin typeface="([^"]*)"/.exec(strFromU8(theme))?.[1] ?? "")

		out.push({ name, bytes, pages, breaks, minorFont })
	}

	return out
}

// Whether the page numbers PAGEREF fields (a table of contents) last showed agree with the recorded breaks,
// up to one offset (the first page number). Word leaves breaks out of some field results and records
// some it never made, which shifts every page after them: such files are no ground truth.
function pageRefsAgree(xml: string): boolean {
	const breaks: number[] = []
	const marks = new Map<string, number>()

	for (const match of xml.matchAll(/<w:lastRenderedPageBreak\/>|<w:bookmarkStart [^>]*w:name="([^"]+)"/g)) {
		if (match[1] === undefined) breaks.push(match.index)
		else marks.set(match[1], match.index)
	}

	let offset: number | undefined

	for (const match of xml.matchAll(
		/PAGEREF\s+(\S+)[^<]*<\/w:instrText>[\s\S]{0,1200}?w:fldCharType="separate"\/>[\s\S]{0,600}?<w:t>(\d+)<\/w:t>/g
	)) {
		const at = marks.get(match[1] ?? "")

		if (at === undefined) continue

		let page = 1

		while (page - 1 < breaks.length && (breaks[page - 1] ?? Infinity) < at) page++

		// A break after the bookmark with no text between them starts the bookmarked text's page.
		const next = breaks[page - 1]

		if (next !== undefined && !/<w:t[ >]/.test(xml.slice(at, next))) page++

		const difference = Number(match[2]) - page

		if (offset === undefined) offset = difference
		else if (offset !== difference) return false
	}

	return true
}

interface FileResult {
	readonly name: string
	// The document's default font (docDefaults and Normal style).
	readonly font: string
	// Every ascii font family the text uses.
	readonly families: readonly string[]
	readonly truth: number
	readonly ours: number
	// Per Word page break: lines between our page start and Word's (positive: we start the page earlier).
	readonly offsets: number[]
	// Per Word page break: our page minus Word's.
	readonly pageOffsets: number[]
	readonly drift: number
	readonly ms: number
}

// Word's page number of each recorded break, by (paragraph item, ordinal within the paragraph).
function wordPages(layout: DocumentLayout): Map<string, number> {
	const out = new Map<string, number>()
	const story = layout.model.body
	const part = story === undefined ? undefined : layout.model.parts[story.part]

	if (part === undefined) return out

	let paragraph = -1
	let ordinal = 0
	let page = 1

	for (let item = 0; item < part.count; item++) {
		const kind = part.kinds[item]

		if (kind === Item.Paragraph) {
			paragraph = item
			ordinal = 0
		} else if (kind === Item.LastRenderedPageBreak) {
			page++
			out.set(`${paragraph}:${ordinal++}`, page)
		}
	}

	return out
}

async function measure(
	truth: Truth,
	options: LayoutOptions,
	fonts?: (manager: FontManager) => ReturnType<typeof adjustedFonts>,
	settings?: (settings: StyleSettings) => StyleSettings
): Promise<FileResult> {
	const started = performance.now()
	const layout = await layOut(truth.bytes, options, fonts, settings)
	const ms = performance.now() - started
	const word = wordPages(layout)
	const offsets: number[] = []
	const pageOffsets: number[] = []

	for (const found of layout.renderedBreaks) {
		const page = word.get(`${found.item}:${found.ordinal}`)

		if (page === undefined) continue

		pageOffsets.push(found.page + 1 - page)

		const first = layout.pageFirstLines[page - 1]

		if (first !== undefined) offsets.push(found.line - first)
	}

	let drift = 0

	for (let k = 1; k < offsets.length; k++) drift += (offsets[k] ?? 0) - (offsets[k - 1] ?? 0)

	const resolver = layout.loaded.resolver
	const font = resolver.run(resolver.paragraph({}), {}).fonts.ascii
	const families = [...new Set(layout.styleInfo.map(info => info?.run?.fonts.ascii.toLowerCase() ?? ""))].filter(name => name !== "")

	return {
		name: truth.name,
		font,
		families,
		truth: truth.pages,
		ours: layout.pages.length,
		offsets,
		pageOffsets,
		drift: offsets.length > 1 ? drift / (offsets.length - 1) : 0,
		ms
	}
}

interface Summary {
	readonly files: number
	readonly exact: number
	readonly withinOne: number
	readonly meanDelta: number
	readonly meanOffset: number
	readonly meanAbsOffset: number
	readonly meanDrift: number
	// Share of Word's breaks we break at exactly, and within one line.
	readonly zero: number
	readonly nearby: number
	// Share of Word's breaks that land on the page Word starts with them.
	readonly samePage: number
}

function summarize(results: readonly FileResult[]): Summary {
	const offsets = results.flatMap(result => result.offsets)

	return {
		files: results.length,
		exact: results.filter(result => result.ours === result.truth).length,
		withinOne: results.filter(result => Math.abs(result.ours - result.truth) <= 1).length,
		meanDelta: results.reduce((sum, result) => sum + (result.ours - result.truth), 0) / Math.max(1, results.length),
		meanOffset: offsets.reduce((sum, offset) => sum + offset, 0) / Math.max(1, offsets.length),
		meanAbsOffset: offsets.reduce((sum, offset) => sum + Math.abs(offset), 0) / Math.max(1, offsets.length),
		meanDrift: results.reduce((sum, result) => sum + result.drift, 0) / Math.max(1, results.length),
		zero: offsets.filter(offset => offset === 0).length / Math.max(1, offsets.length),
		nearby: offsets.filter(offset => Math.abs(offset) <= 1).length / Math.max(1, offsets.length),
		samePage:
			results.flatMap(result => result.pageOffsets).filter(offset => offset === 0).length /
			Math.max(1, results.flatMap(result => result.pageOffsets).length)
	}
}

function format(label: string, summary: Summary): string {
	return (
		`${label.padEnd(34)} files ${summary.files}  exact ${summary.exact}  ±1 ${summary.withinOne} (${((100 * summary.withinOne) / Math.max(1, summary.files)).toFixed(1)} %)  ` +
		`Δpages ${summary.meanDelta.toFixed(2)}  breaks on Word's page ${(100 * summary.samePage).toFixed(1)} %  exact ${(100 * summary.zero).toFixed(1)} % ±1 line ${(100 * summary.nearby).toFixed(1)} %  ` +
		`offset ${summary.meanOffset.toFixed(2)} (|${summary.meanAbsOffset.toFixed(2)}|)  drift/page ${summary.meanDrift.toFixed(2)}`
	)
}

function scaleFamily(prefix: string, scale: number): (manager: FontManager) => ReturnType<typeof adjustedFonts> {
	return manager =>
		adjustedFonts(manager, (request: FontRequest, font: ResolvedFont) =>
			request.family.toLowerCase().startsWith(prefix) ? { ...font, id: font.id + 100000, scale } : font
		)
}

// Draws `family` in its substitute at `scale`, with the substitute's own line metrics (`line` undefined) or
// single lines `line` em high (the substitute's descent kept in proportion): no calibrated table entry.
function candidateMetrics(
	family: string,
	scale: number,
	line: number | undefined
): (manager: FontManager) => ReturnType<typeof adjustedFonts> {
	const substitution = SUBSTITUTIONS.get(family)

	return manager =>
		adjustedFonts(manager, (request: FontRequest, font: ResolvedFont) => {
			if (request.family.toLowerCase() !== family || substitution === undefined) return font

			const face = bundledFace(substitution.family, font.weight, font.italic)
			const m = face?.metrics ?? null

			if (line === undefined) return { ...font, id: font.id + 300000, scale, metrics: m, metricsBasis: "substitute" }

			const units = m === null ? 1000 : m.winAscent + m.winDescent
			const descent = m === null || units <= 0 ? 0.21 : m.winDescent / units
			const ascent = Math.round(1000 * line * (1 - descent))
			const below = Math.round(1000 * line * descent)

			return {
				...font,
				id: font.id + 300000,
				scale,
				metricsBasis: "original",
				metrics: verticalMetrics(1000, ascent, -below, 0, ascent, -below, 0, ascent, below, false)
			}
		})
}

// Calibration evidence a family needs, and the grid searched (then refined around the best).
const CALIBRATION_MIN_FILES = 5
const CALIBRATION_MIN_BREAKS = 40
const CALIBRATION_STEPS: readonly { readonly lines: readonly number[]; readonly scales: readonly number[] }[] = [
	{ lines: [1.0, 1.04, 1.08, 1.12, 1.16, 1.2, 1.24, 1.28, 1.32, 1.36], scales: [0.88, 0.91, 0.94, 0.97, 1, 1.03, 1.06, 1.09, 1.12] },
	{ lines: [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03], scales: [-0.02, -0.01, 0.01, 0.02] }
]

function lineHeightOf(family: string, factor: number): (manager: FontManager) => ReturnType<typeof adjustedFonts> {
	return manager =>
		adjustedFonts(manager, (request: FontRequest, font: ResolvedFont) => {
			const m = font.metrics

			if (request.family.toLowerCase() !== family || m === null) return font

			return {
				...font,
				id: font.id + 200000,
				metrics: {
					...m,
					winAscent: m.winAscent * factor,
					winDescent: m.winDescent * factor,
					hheaAscender: m.hheaAscender * factor,
					hheaDescender: m.hheaDescender * factor,
					hheaLineGap: m.hheaLineGap * factor,
					typoAscender: m.typoAscender * factor,
					typoDescender: m.typoDescender * factor,
					typoLineGap: m.typoLineGap * factor
				}
			}
		})
}

// Encrypted packages are the only refusal the corpus holds (docxModelCorpus.test.ts pins it); any other throw,
// a refusal for another reason included, is a failure.
function isEncryptedRefusal(error: unknown): boolean {
	return error instanceof DocxRefusedError && error.reason === "encrypted"
}

// Lays out one file for the sweep: refused for an encrypted package, else the failure when it does not lay out.
async function sweepFile(
	bytes: Uint8Array,
	lay: (bytes: Uint8Array, options: LayoutOptions) => Promise<DocumentLayout> = layOut
): Promise<{ readonly refused: boolean; readonly failure?: string }> {
	try {
		const layout = await lay(bytes, { maxPages: 5000 })

		expect(layout.final).toBe(true)
		expect(layout.pages.length).toBeGreaterThan(0)

		return { refused: false }
	} catch (error) {
		if (isEncryptedRefusal(error)) return { refused: true }

		return { refused: false, failure: String(error) }
	}
}

describe("corpus layout sweep", () => {
	it("reports a layout crash and skips only encrypted packages", async () => {
		const bytes = new Uint8Array(0)

		expect(await sweepFile(bytes, () => Promise.reject(new RangeError("Invalid typed array length")))).toEqual({
			refused: false,
			failure: "RangeError: Invalid typed array length"
		})
		expect(await sweepFile(bytes, () => Promise.reject(new DocxRefusedError("encrypted", "password")))).toEqual({ refused: true })
		expect(await sweepFile(bytes, () => Promise.reject(new DocxRefusedError("invalidPackage", "no document part")))).toEqual({
			refused: false,
			failure: "Error: invalidPackage: no document part"
		})
	})
})

describe.skipIf(!present)("layout against Word's recorded page breaks", () => {
	it("agrees on the page count of Word-authored files", async () => {
		const byName = new Map<string, FileResult>()
		const run = async (set: TruthSet): Promise<FileResult[]> => {
			const results: FileResult[] = []

			for (const truth of groundTruth(set)) {
				let result = byName.get(truth.name)

				if (result === undefined) {
					result = await measure(truth, {})
					byName.set(truth.name, result)
				}

				results.push(result)
			}

			return results
		}
		const results = await run("corrected")
		const pages = await run("pages")
		const corrected = new Set(results.map(result => result.name))
		const summary = summarize(results)
		const lines = [format("corrected ground truth", summary), format("<Pages> only", summarize(pages))]

		for (const result of pages) {
			if (!corrected.has(result.name))
				lines.push(`  not ground truth (page references disagree): ${result.name}, ${format("", summarize([result])).trim()}`)
		}

		for (const result of results) {
			if (result.ours !== result.truth) {
				lines.push(
					`  ${result.name}: Word ${result.truth}, ours ${result.ours}, pages ${result.pageOffsets.join(" ")}, lines ${result.offsets.slice(0, 8).join(" ")}`
				)
			}
		}

		const slowest = results.reduce((max, result) => (result.ms > max.ms ? result : max), results[0] ?? { name: "", ms: 0 })

		lines.push(`slowest ${slowest.name} ${slowest.ms.toFixed(0)} ms`)
		console.log(lines.join("\n"))

		expect(summary.files).toBeGreaterThan(50)
		expect(summary.withinOne / summary.files).toBeGreaterThanOrEqual(0.9)
	}, 600000)

	// Every corpus document that lays out (all of docx/), from a third and two thirds of its pages.
	it("lays out again from any page exactly as a full layout does", async () => {
		const differences: string[] = []
		let checked = 0

		for (const name of readdirSync(DIRECTORY).sort()) {
			if (!name.endsWith(".docx")) continue

			let layout: DocumentLayout

			try {
				layout = await layOut(readBytes(join(DIRECTORY, name)), { maxPages: 5000 })
			} catch (error) {
				if (!isEncryptedRefusal(error)) differences.push(`${name}: ${String(error)}`)

				continue
			}

			const expected = layoutDigest(layout)

			checked++

			for (const page of [Math.floor(layout.pages.length / 3), Math.floor((2 * layout.pages.length) / 3)]) {
				const from = await layout.relayoutFrom(page)
				const actual = layoutDigest(layout)

				if (actual.join() !== expected.join()) {
					const first = actual.findIndex((digest, k) => digest !== expected[k])

					differences.push(
						`${name} from page ${from}: first difference on page ${first} (${actual.length} vs ${expected.length} pages)`
					)
				}
			}
		}

		console.log(`laid out again from two pages each: ${checked} documents`)
		expect(checked).toBeGreaterThan(100)
		expect(differences).toEqual([])
	}, 1200000)

	it("lays out every corpus document", async () => {
		const failures: string[] = []
		const refused: string[] = []
		const slow: string[] = []

		for (const name of readdirSync(DIRECTORY).sort()) {
			if (!name.endsWith(".docx")) continue

			const started = performance.now()
			const result = await sweepFile(readBytes(join(DIRECTORY, name)))

			if (result.refused) refused.push(name)

			if (result.failure !== undefined) failures.push(`${name}: ${result.failure}`)

			const ms = performance.now() - started

			if (ms > 1000) slow.push(`${name} ${ms.toFixed(0)} ms`)
		}

		console.log(`refused (encrypted): ${refused.length} ${refused.join(", ")}\n${slow.join("\n")}`)
		expect(failures).toEqual([])
	}, 600000)

	// FILEN_OFFICE_LAYOUT_CALIBRATE=<families, lower case> fits a line height (em) and a width scale per family to
	// Word's recorded breaks over the ground-truth files using it, starting from the substitute's own metrics
	// (coordinate descent, ties keep the current value). A family qualifies only with at least
	// CALIBRATION_MIN_FILES files and CALIBRATION_MIN_BREAKS breaks, and its fit ships only when it beats the
	// substitute's own metrics held out: each file scored with the values fitted on the others.
	it.runIf(process.env["FILEN_OFFICE_LAYOUT_CALIBRATE"] !== undefined)(
		"calibrates families",
		async () => {
			const truths = groundTruth(process.env["FILEN_OFFICE_LAYOUT_LOOSE"] === "1" ? "loose" : "corrected")
			const users = new Map<string, Truth[]>()

			for (const truth of truths) {
				for (const family of (await measure(truth, {})).families) users.set(family, [...(users.get(family) ?? []), truth])
			}

			for (const family of (process.env["FILEN_OFFICE_LAYOUT_CALIBRATE"] ?? "").split(",")) {
				const subset = users.get(family) ?? []
				const scores = new Map<string, { exact: number; total: number }>()
				// Exact breaks and breaks of one file under (scale, line); `line` undefined: the substitute's own.
				const fileScore = async (
					truth: Truth,
					scale: number,
					line: number | undefined
				): Promise<{ exact: number; total: number }> => {
					const key = `${truth.name}|${scale}|${line ?? "own"}`
					let score = scores.get(key)

					if (score === undefined) {
						const result = await measure(truth, {}, candidateMetrics(family, scale, line))

						score = { exact: result.offsets.filter(offset => offset === 0).length, total: result.offsets.length }
						scores.set(key, score)
					}

					return score
				}
				const score = async (files: readonly Truth[], scale: number, line: number | undefined): Promise<number> => {
					let exact = 0

					for (const truth of files) exact += (await fileScore(truth, scale, line)).exact

					return exact
				}
				const fit = async (files: readonly Truth[]): Promise<{ scale: number; line: number | undefined }> => {
					let scale = 1
					let line: number | undefined = undefined
					let best = await score(files, scale, line)

					for (const [round, step] of CALIBRATION_STEPS.entries()) {
						const center = line
						const lines: readonly number[] =
							round === 0
								? step.lines
								: center === undefined
									? []
									: step.lines.map(delta => Math.round((center + delta) * 100) / 100)
						const scales: readonly number[] =
							round === 0 ? step.scales : step.scales.map(delta => Math.round((scale + delta) * 100) / 100)

						for (const candidate of lines) {
							const value = await score(files, scale, candidate)

							if (value > best) {
								best = value
								line = candidate
							}
						}

						for (const candidate of scales) {
							const value = await score(files, candidate, line)

							if (value > best) {
								best = value
								scale = candidate
							}
						}
					}

					return { scale, line }
				}

				let breaks = 0

				for (const truth of subset) breaks += (await fileScore(truth, 1, undefined)).total

				const own = await score(subset, 1, undefined)
				const all = await fit(subset)
				const fitted = await score(subset, all.scale, all.line)
				let heldOut = 0

				for (const truth of subset) {
					const values = await fit(subset.filter(other => other !== truth))

					heldOut += (await fileScore(truth, values.scale, values.line)).exact
				}

				const qualifies = subset.length >= CALIBRATION_MIN_FILES && breaks >= CALIBRATION_MIN_BREAKS
				const percent = (exact: number): string => `${((100 * exact) / Math.max(1, breaks)).toFixed(1)} %`

				console.log(
					`${family}: ${subset.length} files, ${breaks} breaks; substitute ${percent(own)}; fitted scale ${all.scale}, line ${all.line ?? "own"} em: ` +
						`${percent(fitted)} in sample, ${percent(heldOut)} held out (leave one file out) -> ` +
						(!qualifies ? "too little evidence" : heldOut > own ? "ship" : "keep the substitute's metrics")
				)
			}
		},
		3600000
	)

	it.runIf(process.env["FILEN_OFFICE_LAYOUT_DIAGNOSE"] !== undefined)(
		"diagnoses where breaks miss",
		async () => {
			const lines: string[] = []

			for (const truth of groundTruth()) {
				const layout = await layOut(truth.bytes, {})
				const result = await measure(truth, {})
				const stats = modelStats(layout.model)
				const fonts = new Map<string, string>()

				for (const info of layout.styleInfo) {
					const run = info?.run

					if (run === undefined) continue

					const family = run.fonts.ascii.toLowerCase()

					if (!fonts.has(family)) fonts.set(family, SUBSTITUTIONS.has(family) ? "sub" : "fallback")
				}

				const exact = result.offsets.filter(offset => offset === 0).length
				const steps = result.offsets.map((offset, k) => offset - (k === 0 ? 0 : (result.offsets[k - 1] ?? 0)))

				lines.push(
					[
						truth.name.slice(0, 48).padEnd(48),
						`${exact}/${result.offsets.length}`.padStart(7),
						`pages ${result.ours}/${truth.pages}`,
						`tbl ${stats.tables} math ${stats.kinds["Math"] ?? 0}+${stats.kinds["MathParagraph"] ?? 0} drw ${stats.anchoredDrawings}/${stats.drawings["total"] ?? Object.values(stats.drawings).reduce((a, b) => a + b, 0)} fn ${stats.footnotes} sec ${stats.sections}`,
						`fonts ${[...fonts].map(([family, kind]) => (kind === "sub" ? family : `${family}*`)).join(",")}`,
						`steps ${steps.join(" ")}`
					].join(" | ")
				)
			}

			writeFileSync(process.env["FILEN_OFFICE_LAYOUT_DIAGNOSE"] ?? "", lines.join("\n"))
		},
		3600000
	)

	it.runIf(process.env["FILEN_OFFICE_LAYOUT_COMPARE"] !== undefined)(
		"compares two settings per file",
		async () => {
			const truths = groundTruth()
			const variant = JSON.parse(process.env["FILEN_OFFICE_LAYOUT_COMPARE"] ?? "{}") as LayoutOptions
			const lines: string[] = []

			for (const truth of truths) {
				const a = await measure(truth, {})
				const b = await measure(truth, variant)

				if (a.ours !== b.ours || a.offsets.join() !== b.offsets.join()) {
					lines.push(
						`${truth.name.slice(0, 60).padEnd(60)} Word ${truth.pages}  base ${a.ours} [${a.offsets.slice(0, 6).join(" ")}]  variant ${b.ours} [${b.offsets.slice(0, 6).join(" ")}]`
					)
				}
			}

			console.log(lines.join("\n"))
		},
		3600000
	)

	it.runIf(process.env["FILEN_OFFICE_LAYOUT_SWEEP"] === "1")(
		"overrideTableStyleFontSizeAndJustification under compatibility mode 15",
		async () => {
			const truths = groundTruth("loose")
			const on = (settings: StyleSettings): StyleSettings =>
				settings.compatibilityMode === 15 ? { ...settings, overrideTableStyleFontSizeAndJustification: true } : settings
			const lines: string[] = []
			const base: FileResult[] = []
			const variant: FileResult[] = []

			for (const truth of truths) {
				const a = await measure(truth, {})
				const b = await measure(truth, {}, undefined, on)

				base.push(a)
				variant.push(b)

				if (a.ours !== b.ours || a.pageOffsets.join() !== b.pageOffsets.join()) {
					lines.push(
						`  ${truth.name.slice(0, 60).padEnd(60)} Word ${truth.pages}  spec ${a.ours} [${a.pageOffsets.join(" ")}]  on ${b.ours} [${b.pageOffsets.join(" ")}]`
					)
				}
			}

			console.log(
				[format("as MS-DOCX specifies", summarize(base)), format("on under compat 15", summarize(variant)), ...lines].join("\n")
			)
		},
		3600000
	)

	it.runIf(process.env["FILEN_OFFICE_LAYOUT_SWEEP"] === "1")(
		"calibration sweep",
		async () => {
			const truths = groundTruth()
			const run = async (
				label: string,
				subset: readonly Truth[],
				options: LayoutOptions,
				fonts?: (manager: FontManager) => ReturnType<typeof adjustedFonts>
			) => {
				const results: FileResult[] = []

				for (const truth of subset) results.push(await measure(truth, options, fonts))

				console.log(format(label, summarize(results)))
			}

			// Each choice below is decided by one metric fixed in advance: the share of Word's recorded breaks our
			// layout breaks at on exactly the same line; ties go to the value closer to the default.
			await run("gdi", truths, { lineSpacingRule: "gdi" })
			await run("typoWhenFlagged", truths, { lineSpacingRule: "typoWhenFlagged" })

			for (const mode of ["overflow", "breaks", "compat", "never"] as const)
				await run(`page top space dropped: ${mode}`, truths, { tuning: { dropSpaceAtPageTop: mode } })

			for (const mode of ["sum", "max", "auto"] as const)
				await run(`paragraph spacing: ${mode}`, truths, { tuning: { paragraphSpacing: mode } })

			for (const mode of ["fit", "overhang"] as const)
				await run(`space after above notes: ${mode}`, truths, { tuning: { noteSpaceAfter: mode } })

			const aptos = groundTruth("loose").filter(truth => truth.minorFont.startsWith("Aptos"))

			for (const scale of [1, 1.01, 1.015, 1.02, 1.025, 1.03, 1.04, 1.05, 1.06, 1.07]) {
				await run(`aptos ×${scale} (${aptos.length})`, aptos, {}, scaleFamily("aptos", scale))

				if (process.env["FILEN_OFFICE_LAYOUT_DETAIL"] === "1") {
					for (const truth of aptos) {
						const result = await measure(truth, {}, scaleFamily("aptos", scale))

						console.log(
							`    ${truth.name.slice(0, 50)} Word ${truth.pages} ours ${result.ours} pages [${result.pageOffsets.join(" ")}] lines [${result.offsets.join(" ")}]`
						)
					}
				}
			}

			// Line height per font family: which factor on our line metrics fits Word's breaks best, over the
			// files using the family anywhere.
			const byFamily = new Map<string, Truth[]>()

			for (const truth of truths) {
				for (const family of (await measure(truth, {})).families) byFamily.set(family, [...(byFamily.get(family) ?? []), truth])
			}

			const wanted = (
				process.env["FILEN_OFFICE_LAYOUT_FAMILIES"] ?? "calibri,cambria,georgia,segoe ui,arial,times new roman,tahoma"
			).split(",")

			for (const family of wanted) {
				const subset = byFamily.get(family) ?? []

				if (subset.length === 0) continue

				for (const factor of [0.88, 0.92, 0.96, 1, 1.04, 1.08])
					await run(`${family} line ×${factor} (${subset.length})`, subset, {}, lineHeightOf(family, factor))
			}
		},
		3600000
	)
})
