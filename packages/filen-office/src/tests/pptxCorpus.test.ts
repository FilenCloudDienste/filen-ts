import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx, type PptxParts } from "../core/pptx/package"
import { resolveShape, type PlaceholderMatch } from "../core/presentation/inherit"
import type { Deck, ShapeNode, SlideNode } from "../core/presentation/model"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { loCacheDir, readLoCache, type LoDeck, type LoShape } from "./oracles/presentation/lo"

// Every OOXML presentation of the frozen corpus through the reader, against LibreOffice 7.5 over UNO (the oracle
// cache, FILEN_OFFICE_LO_CACHE): each opens or refuses typed; slide count, hidden flags, layout names, slide size,
// placeholder boxes after inheritance, notes text and custom shows match. Sections are checked against the
// presentation part's own markup (LibreOffice 7.5 does not expose them).

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files.filter(file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path))
const PRESENT = FILES.filter(file => existsSync(join(CORPUS_DIR, file.path)))
const CACHE = loCacheDir()

interface Opened {
	readonly path: string
	readonly sha256: string
	readonly bytes: Uint8Array
	readonly deck: Deck
	readonly parts: PptxParts
}

let all: Promise<{ readonly opened: Opened[]; readonly refused: Map<string, string> }> | undefined

// Opens (and parses) every present unencrypted corpus deck once for the whole file.
function corpus(): Promise<{ readonly opened: Opened[]; readonly refused: Map<string, string> }> {
	all ??= (async () => {
		const opened: Opened[] = []
		const refused = new Map<string, string>()

		for (const file of PRESENT) {
			if (file.password !== undefined) continue

			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const open = await openPptx(bytesSource(bytes))

			if (open.kind === "refused") {
				refused.set(file.path, open.reason)

				continue
			}

			await open.parts.parseAll()
			opened.push({ path: file.path, sha256: file.sha256, bytes, deck: open.deck, parts: open.parts })
		}

		return { opened, refused }
	})()

	return all
}

function oracle(entry: Opened): LoDeck | undefined {
	if (CACHE === undefined) return undefined

	const deck = readLoCache(CACHE, entry.sha256)?.deck

	return deck?.slides === undefined ? undefined : deck
}

function node(deck: Deck, ref: SlideNode["ref"] | undefined): SlideNode | undefined {
	return ref === undefined ? undefined : deck.nodes.get(ref)
}

describe.skipIf(PRESENT.length === 0)("OOXML presentation corpus", () => {
	it("opens every unencrypted deck, refusing none", { timeout: 120_000 }, async () => {
		const { opened, refused } = await corpus()

		expect([...refused]).toEqual([])
		expect(opened.length).toBe(PRESENT.filter(file => file.password === undefined).length)
	})

	describe.skipIf(CACHE === undefined)("against LibreOffice 7.5", () => {
		it("has the slide count, hidden flags and slide size of every deck", { timeout: 120_000 }, async () => {
			const { opened } = await corpus()
			const compared: string[] = []

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				compared.push(entry.path)
				expect(entry.deck.slides.length, entry.path).toBe(lo.slides.length)
				expect(
					entry.deck.slides.map(ref => node(entry.deck, ref)?.hidden),
					entry.path
				).toEqual(lo.slides.map(slide => slide.hidden))
				expect([Math.round(entry.deck.size.cx / 360), Math.round(entry.deck.size.cy / 360)], entry.path).toEqual(lo.slideSize100mm)
			}

			expect(compared.length).toBe(opened.length)
		})

		it("has the hidden flags at open, before any slide is parsed", { timeout: 120_000 }, async () => {
			const { opened } = await corpus()

			for (const entry of opened) {
				const fresh = await openPptx(bytesSource(entry.bytes))

				if (fresh.kind !== "opened") throw new Error(fresh.reason)

				expect(
					fresh.deck.slides.map(ref => fresh.parts.hiddenAtOpen.has(ref)),
					entry.path
				).toEqual(entry.deck.slides.map(ref => node(entry.deck, ref)?.hidden))
			}
		})

		it("names each slide's layout as LibreOffice names its master page", { timeout: 120_000 }, async () => {
			const { opened } = await corpus()

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				// LibreOffice 7.5 makes one master page per layout in use, in order of first use, named as the layout; a
				// name already taken (or none) becomes "Default", then "Default 1"…
				const pages = new Map<SlideNode | undefined, string>()
				const taken = new Set<string>()
				const pageName = (layout: SlideNode | undefined): string => {
					const held = pages.get(layout)

					if (held !== undefined) return held

					let name = layout?.name ?? ""

					if (name === "" || taken.has(name)) {
						name = "Default"

						for (let index = 1; taken.has(name); index++) name = `Default ${String(index)}`
					}

					taken.add(name)
					pages.set(layout, name)

					return name
				}

				expect(
					entry.deck.slides.map(ref => pageName(node(entry.deck, node(entry.deck, ref)?.parent))),
					entry.path
				).toEqual(lo.slides.map(slide => slide.master))
				expect([...new Set(pages.values())], entry.path).toEqual(lo.masters)
			}
		})

		// Inherited boxes where PowerPoint's documented rule and LibreOffice part: a written idx matches the layout
		// placeholder of that idx whatever its class (MS-OI29500 §2.1.1127(b)); LibreOffice keeps the class.
		const WRITTEN_IDX_EXCEPTIONS: readonly {
			readonly path: string
			readonly slide: number
			readonly type: string
			readonly idx: number
		}[] = [
			{ path: "pptx/govuk__Sector_Skills_Insights_Advanced_Manufacturing_summary_slide_pack.pptx", slide: 4, type: "sldNum", idx: 11 }
		]
		const followsWrittenIdx = (
			path: string,
			index: number,
			shape: { readonly ph?: { readonly type?: string; readonly idx?: number } }
		): boolean =>
			WRITTEN_IDX_EXCEPTIONS.some(
				exception =>
					exception.path === path &&
					exception.slide === index + 1 &&
					exception.type === shape.ph?.type &&
					exception.idx === shape.ph.idx
			)

		it("places ≥ 98% of placeholders within 50 (1/100 mm) of LibreOffice after inheritance", { timeout: 120_000 }, async ({ task }) => {
			const { opened } = await corpus()
			const counts: Record<PlaceholderMatch, { total: number; within: number }> = {
				idx: { total: 0, within: 0 },
				type: { total: 0, within: 0 },
				master: { total: 0, within: 0 },
				none: { total: 0, within: 0 }
			}
			let total = 0
			let within = 0
			let inheritedTotal = 0
			let inheritedWithin = 0
			let unaligned = 0

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				entry.deck.slides.forEach((ref, index) => {
					const slide = node(entry.deck, ref)
					const pairs = slide === undefined ? undefined : align(slide.shapes, lo.slides?.[index]?.shapes ?? [])

					if (slide === undefined || pairs === undefined) {
						unaligned++

						return
					}

					for (const [shape, theirs] of pairs) {
						if (shape.ph === undefined || theirs.box100mm === undefined) continue

						const resolved = resolveShape(entry.deck, ref, shape)
						const box =
							resolved.xfrm === undefined
								? [0, 0, 0, 0]
								: [resolved.xfrm.x, resolved.xfrm.y, resolved.xfrm.cx, resolved.xfrm.cy].map(v => v / 360)
						const ok = box.every((value, at) => Math.abs(value - (theirs.box100mm?.[at] ?? Number.NaN)) <= 50)

						total++
						counts[resolved.match].total++

						if (ok) {
							within++
							counts[resolved.match].within++
						}

						if (shape.xfrm === undefined && !followsWrittenIdx(entry.path, index, shape)) {
							inheritedTotal++
							if (ok) inheritedWithin++
						}
					}
				})
			}

			Object.assign(task.meta, { placeholders: { total, within, inheritedTotal, inheritedWithin, unaligned, counts } })
			expect(total).toBeGreaterThan(3000)
			expect(within / total).toBeGreaterThanOrEqual(0.98)
			// Every miss has a box of its own (LibreOffice grows auto-fitting text and tables): inheritance itself places
			// every inherited box where LibreOffice does.
			expect(inheritedWithin).toBe(inheritedTotal)
			expect(unaligned).toBeLessThan(10)
		})

		it("has the notes text of ≥ 99% of notes after normalisation", { timeout: 120_000 }, async ({ task }) => {
			const { opened } = await corpus()
			let total = 0
			let equal = 0

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				const notesMaster = node(entry.deck, entry.deck.notesMaster)

				entry.deck.slides.forEach((ref, index) => {
					const notes = node(entry.deck, node(entry.deck, ref)?.notes)
					const ours = normalise(
						(notes?.shapes ?? [])
							.filter(shape => shape.ph?.type === "body")
							.map(shape => plain(shape))
							.join("\n")
					)
					const theirs = (lo.slides?.[index]?.notes ?? []).map(normalise)
					// Beside the body LibreOffice lists the notes page's header, footer, date and number placeholders (of the
					// notes slide or, shown through, the notes master), their fields evaluated.
					const others = [...(notes?.shapes ?? []), ...(notesMaster?.shapes ?? [])]
						.filter(shape => shape.ph !== undefined && shape.ph.type !== "body")
						.map(shape => normalise(plain(shape, false)))
						.filter(text => text !== "")
					const explained = (text: string): boolean =>
						text === "" || /^(<number>|\d+|\d{1,2}\/\d{1,2}\/\d{4})$/u.test(text) || others.some(other => text.includes(other))

					if (ours === "" && theirs.every(explained)) return

					total++
					if (theirs.includes(ours)) equal++
				})
			}

			Object.assign(task.meta, { notes: { total, equal } })
			expect(total).toBeGreaterThan(500)
			expect(equal / total).toBeGreaterThanOrEqual(0.99)
		})

		it("has the custom shows of every deck", { timeout: 120_000 }, async () => {
			const { opened } = await corpus()

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo === undefined) continue

				expect(
					entry.deck.customShows.map(show => show.name),
					entry.path
				).toEqual(lo.customShows ?? [])
			}
		})
	})

	it("has the sections the presentation part writes", { timeout: 120_000 }, async () => {
		const { opened } = await corpus()
		let decks = 0

		for (const entry of opened) {
			const markup = new TextDecoder().decode(await entry.parts.opc.read("ppt/presentation.xml"))
			const sections = [...markup.matchAll(/<p14:section\b[^>]*\bname="([^"]*)"[^>]*>(.*?)<\/p14:section>/gsu)]
			const ids = new Map(entry.deck.slides.map(ref => [entry.parts.slideId(ref), ref]))

			if (sections.length > 0) decks++

			expect(
				entry.deck.sections.map(section => [section.name, section.slides]),
				entry.path
			).toEqual(
				sections.map(match => [
					unescape(match[1] ?? ""),
					[...(match[2] ?? "").matchAll(/<p14:sldId\b[^>]*\bid="(\d+)"/gu)]
						.map(id => ids.get(Number(id[1])))
						.filter(ref => ref !== undefined)
				])
			)
		}

		expect(decks).toBeGreaterThan(5)
	})
})

function unescape(text: string): string {
	return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&")
}

function normalise(text: string): string {
	return text.split(/\s+/u).join(" ").trim()
}

function plain(shape: ShapeNode, fields = true): string {
	return (shape.text?.paragraphs ?? [])
		.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.kind === "fld" && !fields ? "" : run.text)).join(""))
		.join("\n")
}

const FOOTERS: Readonly<Record<string, string>> = {
	dt: "DateTimeShape",
	ftr: "FooterShape",
	sldNum: "SlideNumberShape",
	hdr: "HeaderShape"
}

// Pairs our top-level shapes with LibreOffice's. LibreOffice leaves out slide-level date, footer, number and header
// placeholders it turns into header and footer settings, and ink (p:contentPart): ours of those are skipped where
// its list has no such shape next. Undefined when the lists cannot be aligned.
function align(ours: readonly ShapeNode[], theirs: readonly LoShape[]): [ShapeNode, LoShape][] | undefined {
	const pairs: [ShapeNode, LoShape][] = []
	let at = 0

	for (const shape of ours) {
		const next = theirs[at]

		if (shape.kind === "ink") continue

		const footer = shape.ph === undefined ? undefined : FOOTERS[shape.ph.type]

		if (footer !== undefined && (next === undefined || !next.type.endsWith(footer))) continue
		if (next === undefined) return undefined

		pairs.push([shape, next])
		at++
	}

	return at === theirs.length ? pairs : undefined
}
