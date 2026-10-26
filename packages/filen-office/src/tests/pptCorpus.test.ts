import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptxPackage } from "../core/pptx/package"
import type { Deck, ShapeNode } from "../core/presentation/model"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { loCacheDir, readLoCache, type LoShape } from "./oracles/presentation/lo"
import { CORPUS_PASSWORDS } from "./oracles/presentation/corpus"

// Every PowerPoint 97–2003 deck of the frozen corpus through the reader and the pptx it converts to, against
// LibreOffice 7.5 over UNO (the oracle cache, FILEN_OFFICE_LO_CACHE): each unencrypted deck opens or refuses typed; the
// slide count, the text of each slide and the shape boxes match. Encrypted decks have their own oracle (msoffcrypto,
// pptDecryptOracle.test.ts): LibreOffice 7.5 opens none of them.
//
// Where LibreOffice and PowerPoint part, PowerPoint's behaviour is kept and the slide is listed here:
// - poi__empty.ppt has no slides: LibreOffice shows one empty page, PowerPoint none.
// - poi__62d2ecd8….ppt slides 12–13 hold a group written without an anchor whose members have theirs: PowerPoint
//   draws the members where their anchors put them, LibreOffice leaves the group out.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files.filter(
	file => /^ppt\//u.test(file.path) && file.password === undefined && CORPUS_PASSWORDS[file.path.slice(4)] === undefined
)
const PRESENT = FILES.filter(file => existsSync(join(CORPUS_DIR, file.path)))
const CACHE = loCacheDir()
const EMPTY_DECKS = new Set(["ppt/poi__empty.ppt"])
const LO_DROPS_GROUP: Readonly<Record<string, readonly number[]>> = { "ppt/poi__62d2ecd89aeb715b07072d4f8a8734f4dbeb5c10.ppt": [12, 13] }
// The files a linear record walk derails on (incremental saves): read through the persist directory, they are whole.
const DERAILING = ["ppt/govuk__dh_134012.ppt", "ppt/govuk__mtpas-update.ppt", "ppt/poi__bug45124.ppt"]

interface Opened {
	readonly path: string
	readonly sha256: string
	readonly deck: Deck
}

let all: Promise<{ readonly opened: Opened[]; readonly refused: Map<string, string> }> | undefined

function corpus(): Promise<{ readonly opened: Opened[]; readonly refused: Map<string, string> }> {
	all ??= (async () => {
		const opened: Opened[] = []
		const refused = new Map<string, string>()

		for (const file of PRESENT) {
			const converted = await pptToPptx(bytesSource(new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))))

			if (converted.kind === "refused") {
				refused.set(file.path, converted.reason)

				continue
			}

			const deck = await openPptxPackage(converted.pptx)

			if (deck.kind === "refused") {
				refused.set(file.path, `pptx ${deck.reason}`)

				continue
			}

			await deck.parts.parseAll()
			opened.push({ path: file.path, sha256: file.sha256, deck: deck.deck })
		}

		return { opened, refused }
	})()

	return all
}

// Symbol-font characters LibreOffice keeps in the private use area (U+F020–U+F0FF) as the codes the file wrote.
function normalise(text: string): string {
	return text
		.replace(/[-]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0xf000))
		.replace(/[\v\r\n\t ]+/gu, " ")
		.trim()
}

// LibreOffice's getString, cut at 400 code points as the oracle script cuts it.
function cut(text: string): string {
	return normalise(Array.from(text).slice(0, 400).join(""))
}

const FOOTER_TYPES = new Set(["dt", "ftr", "sldNum", "hdr"])

function plain(shape: ShapeNode, numberAsField: boolean): string {
	return (shape.text?.paragraphs ?? [])
		.map(paragraph =>
			paragraph.runs
				.map(run =>
					run.kind === "br" ? "\n" : run.kind === "fld" && run.type === "slidenum" && numberAsField ? "<number>" : run.text
				)
				.join("")
		)
		.join("\n")
}

// Our texts of a slide (each as written and with slide numbers as LibreOffice's "<number>"), table cells left out as
// LibreOffice's table shapes give no text.
function ourTexts(shapes: readonly ShapeNode[], footers: boolean): (readonly [string, string])[] {
	const out: (readonly [string, string])[] = []

	for (const shape of shapes) {
		if (shape.children !== undefined) out.push(...ourTexts(shape.children, footers))
		else if (!footers && shape.ph !== undefined && FOOTER_TYPES.has(shape.ph.type)) continue
		else {
			const text = cut(plain(shape, false))

			if (text !== "") out.push([text, cut(plain(shape, true))])
		}
	}

	return out
}

function loTexts(shapes: readonly LoShape[]): string[] {
	return shapes
		.flatMap(shape => (shape.children !== undefined ? loTexts(shape.children) : shape.text === undefined ? [] : [cut(shape.text)]))
		.filter(text => text !== "")
}

// LibreOffice's field placeholders and the date it evaluates now: matched by a field of ours or by nothing.
const OPTIONAL = /^(<date\/time>|<footer>|<header>|<number>|\d{1,2}\/\d{1,2}\/\d{2,4}( \d{1,2}:\d{2}( [AP]M)?)?)$/u

function sameTexts(ours: readonly (readonly [string, string])[], theirs: readonly string[]): boolean {
	const left = theirs.filter(text => !OPTIONAL.test(text))

	for (const [text, withField] of ours) {
		let at = left.indexOf(text)

		if (at < 0) at = left.indexOf(withField)
		if (at < 0) {
			if (OPTIONAL.test(withField)) continue

			return false
		}

		left.splice(at, 1)
	}

	return left.length === 0
}

const FOOTERS: Readonly<Record<string, string>> = {
	dt: "DateTimeShape",
	ftr: "FooterShape",
	sldNum: "SlideNumberShape",
	hdr: "HeaderShape"
}

// Our top-level shapes paired with LibreOffice's in order; the footers we show from the master and LibreOffice keeps as
// header and footer settings are passed over. Undefined when the lists do not align.
function align(ours: readonly ShapeNode[], theirs: readonly LoShape[]): [ShapeNode, LoShape][] | undefined {
	const pairs: [ShapeNode, LoShape][] = []
	let at = 0

	for (const shape of ours) {
		const next = theirs[at]
		const footer = shape.ph === undefined ? undefined : FOOTERS[shape.ph.type]

		if (footer !== undefined && (next === undefined || !next.type.endsWith(footer))) continue
		if (next === undefined) return undefined

		pairs.push([shape, next])
		at++
	}

	return at === theirs.length ? pairs : undefined
}

// LibreOffice reports a rotated shape's position as its rotated top-left corner (1/100 mm).
function box(shape: ShapeNode): readonly [number, number, number, number] | undefined {
	const xfrm = shape.xfrm

	if (xfrm === undefined) return undefined

	const [x, y, w, h] = [xfrm.x, xfrm.y, xfrm.cx, xfrm.cy].map(value => value / 360) as [number, number, number, number]
	const angle = (((xfrm.rot ?? 0) / 60000) * Math.PI) / 180

	if (angle === 0) return [x, y, w, h]

	const cx = x + w / 2
	const cy = y + h / 2

	return [cx - (w / 2) * Math.cos(angle) + (h / 2) * Math.sin(angle), cy - (w / 2) * Math.sin(angle) - (h / 2) * Math.cos(angle), w, h]
}

describe.skipIf(PRESENT.length === 0)("ppt corpus", () => {
	it("opens every unencrypted deck, refusing none", { timeout: 300_000 }, async () => {
		const { opened, refused } = await corpus()

		expect([...refused]).toEqual([])
		expect(opened.length).toBe(PRESENT.length)
	})

	it("reads the decks a linear record walk derails on, through the persist directory", { timeout: 300_000 }, async () => {
		const { opened } = await corpus()

		for (const path of DERAILING) {
			const entry = opened.find(deck => deck.path === path)

			if (!existsSync(join(CORPUS_DIR, path))) continue

			expect(entry?.deck.slides.length, path).toBeGreaterThan(0)

			const lo = CACHE === undefined || entry === undefined ? undefined : readLoCache(CACHE, entry.sha256)?.deck

			if (lo?.slides === undefined || entry === undefined) continue

			expect(entry.deck.slides.length, path).toBe(lo.slides.length)
			lo.slides.forEach((slide, index) => {
				const ref = entry.deck.slides[index]
				const shapes = ref === undefined ? [] : (entry.deck.nodes.get(ref)?.shapes ?? [])

				expect(
					sameTexts(ourTexts(shapes, false), loTexts(slide.shapes)) || sameTexts(ourTexts(shapes, true), loTexts(slide.shapes)),
					`${path} slide ${String(index + 1)}`
				).toBe(true)
			})
		}
	})

	describe.skipIf(CACHE === undefined)("against LibreOffice 7.5", () => {
		it("has LibreOffice's slide count for every deck", { timeout: 300_000 }, async () => {
			const { opened } = await corpus()
			let compared = 0

			for (const entry of opened) {
				const lo = CACHE === undefined ? undefined : readLoCache(CACHE, entry.sha256)?.deck

				if (lo?.slides === undefined) continue

				compared++
				expect(entry.deck.slides.length, entry.path).toBe(EMPTY_DECKS.has(entry.path) ? 0 : lo.slides.length)
			}

			expect(compared).toBeGreaterThanOrEqual(95)
		})

		it("has the text of ≥ 97% of slides and ≥ 95% of shape boxes within 1 mm", { timeout: 300_000 }, async ({ task }) => {
			const { opened } = await corpus()
			let slides = 0
			let equalText = 0
			let boxes = 0
			let within = 0
			let unaligned = 0
			const textMisses: string[] = []

			for (const entry of opened) {
				const lo = CACHE === undefined ? undefined : readLoCache(CACHE, entry.sha256)?.deck

				if (lo?.slides === undefined || EMPTY_DECKS.has(entry.path)) continue

				lo.slides.forEach((slide, index) => {
					const ref = entry.deck.slides[index]
					const shapes = ref === undefined ? [] : (entry.deck.nodes.get(ref)?.shapes ?? [])

					if (LO_DROPS_GROUP[entry.path]?.includes(index + 1) === true) return

					slides++

					const theirs = loTexts(slide.shapes)

					if (sameTexts(ourTexts(shapes, false), theirs) || sameTexts(ourTexts(shapes, true), theirs)) equalText++
					else textMisses.push(`${entry.path} ${String(index + 1)}`)

					const pairs = align(shapes, slide.shapes)

					if (pairs === undefined) {
						unaligned++

						return
					}

					for (const [shape, other] of pairs) {
						const ours = box(shape)

						if (ours === undefined || other.box100mm === undefined) continue

						boxes++

						if (ours.every((value, at) => Math.abs(value - (other.box100mm?.[at] ?? Number.NaN)) <= 100)) within++
					}
				})
			}

			Object.assign(task.meta, { ppt: { slides, equalText, boxes, within, unaligned, textMisses } })
			expect(slides).toBeGreaterThan(1000)
			expect(equalText / slides).toBeGreaterThanOrEqual(0.97)
			expect(boxes).toBeGreaterThan(5000)
			expect(within / boxes).toBeGreaterThanOrEqual(0.95)
			expect(unaligned).toBeLessThan(10)
		})
	})
})
