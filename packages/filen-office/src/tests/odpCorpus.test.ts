import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdp, type OdpParts } from "../core/odp/read/document"
import type { Action, Deck, Run, ShapeNode, SlideNode, Xfrm } from "../core/presentation/model"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { loCacheDir, readLoCache, type LoDeck, type LoShape } from "./oracles/presentation/lo"

// Every OpenDocument presentation of the frozen corpus through the ODP reader, against LibreOffice 7.5 over UNO
// (the oracle cache, FILEN_OFFICE_LO_CACHE): each opens or refuses typed; page count, shape boxes, shape text and
// notes text match.
//
// Comparison conventions (what UNO reports, not what the reader decides):
//   - a rotated shape's UNO position is its rotated box's first corner (draw:transform's translation), and its
//     RotateAngle counter-clockwise in 1/100°; ours are DrawingML's unrotated offset and clockwise angle;
//   - UNO's shape text is cut at 400 characters by the oracle script;
//   - fields show what each side evaluates (slide number, date, file path): a field run matches any text.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files.filter(file => /^(odp|otp)\//u.test(file.path))
const PRESENT = FILES.filter(file => existsSync(join(CORPUS_DIR, file.path)))
const CACHE = loCacheDir()

// Shapes whose UNO box differs, by file, each explained (and counted exactly, so a new miss fails):
//   - LibreOffice sizes draw:auto-grow-height shapes and text frames from its own text layout when it loads them, so a
//     stale stored height (or width) is replaced: Presentation4 (69 ellipses shrunk to their text), Presentation2 (4
//     grown), Shaping slide 62, numfmt slide 8, tdf96708 slide 2, SlideTest2 slide 1; we keep the stored box (the box
//     PowerPoint and a save keep; spAutoFit grows the shape when its text is edited);
//   - Workshop in a box: six titles without presentation:user-transformed whose own width is wider than the slide;
//     LibreOffice keeps the master's width (see core/odp/read/shapes.ts);
//   - tdf66228: a connector LibreOffice re-routes between its glue points on load;
//   - tdf92076: a rotated polyline LibreOffice imports with its legacy (pre-ODF 1.2) transform rule, the bug the file
//     was made for.
const EXPECTED_MISSES: Readonly<Record<string, number>> = {
	"odp/odftk__Presentation4.odp": 69,
	"odp/odftk__Presentation2.odp": 4,
	"odp/govuk__Shaping_the_Qualifications_Landscape.odp": 1,
	"odp/lo__numfmt.odp": 1,
	"odp/lo__tdf96708.odp": 1,
	"odp/odftk__SlideTest2.odp": 1,
	"odp/govuk__Workshop_in_a_box_slides_ODP.odp": 6,
	"odp/lo__tdf66228.odp": 1,
	"odp/lo__tdf92076.odp": 1
}

interface Opened {
	readonly path: string
	readonly sha256: string
	readonly bytes: Uint8Array
	readonly deck: Deck
	readonly parts: OdpParts
}

let all: Promise<{ readonly opened: Opened[]; readonly refused: Map<string, string> }> | undefined

function corpus(): Promise<{ readonly opened: Opened[]; readonly refused: Map<string, string> }> {
	all ??= (async () => {
		const opened: Opened[] = []
		const refused = new Map<string, string>()

		for (const file of PRESENT) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const open = await openOdp(bytesSource(bytes))

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

function normalise(text: string): string {
	return text.split(/\s+/u).join(" ").trim()
}

const FIELD = "\u0000"

function plain(shape: ShapeNode): string {
	const run = (item: Run): string => (item.kind === "br" ? "\n" : item.kind === "fld" ? FIELD : item.text)

	return (shape.text?.paragraphs ?? []).map(paragraph => paragraph.runs.map(run).join("")).join("\n")
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

// Our text against UNO's: fields match anything; UNO's text cut at 400 characters matches our text's start.
function sameText(ours: string, theirs: string): boolean {
	const cut = theirs.length >= 400
	const wanted = normalise(theirs)
	const pattern = normalise(ours).split(FIELD).map(escapeRegExp).join(".*?")

	if (!cut) return new RegExp(`^${pattern}$`, "su").test(wanted)

	// The cut may fall inside a word: compare up to UNO's last whole word.
	const prefix = wanted.slice(0, wanted.lastIndexOf(" ") < 0 ? wanted.length : wanted.lastIndexOf(" "))

	return (
		new RegExp(`^${pattern}`, "su").test(prefix) ||
		new RegExp(`^${escapeRegExp(prefix)}`, "su").test(normalise(ours).replaceAll(FIELD, ""))
	)
}

// UNO's box of a shape: the rotated box's first corner (1/100 mm), its size, its counter-clockwise angle.
function unoBox(xfrm: Xfrm): { readonly box: readonly number[]; readonly rot: number } {
	const radians = (xfrm.rot / 60_000) * (Math.PI / 180)
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2
	const dx = -xfrm.cx / 2
	const dy = -xfrm.cy / 2
	const x = cx + dx * Math.cos(radians) - dy * Math.sin(radians)
	const y = cy + dx * Math.sin(radians) + dy * Math.cos(radians)

	return { box: [x / 360, y / 360, xfrm.cx / 360, xfrm.cy / 360], rot: Math.round(((360 - xfrm.rot / 60_000) % 360) * 100) % 36_000 }
}

describe.skipIf(PRESENT.length === 0)("OpenDocument presentation corpus", () => {
	it("opens every deck, refusing none", { timeout: 300_000 }, async () => {
		const { opened, refused } = await corpus()

		expect([...refused]).toEqual([])
		expect(opened.length).toBe(PRESENT.length)
	})

	it("refuses the corpus's macro event listener and javascript: link, and keeps its web links", { timeout: 300_000 }, async () => {
		const { opened } = await corpus()
		const actions = new Map<string, Action[]>()
		const collect = (shapes: readonly ShapeNode[], out: Action[]): void => {
			for (const shape of shapes) {
				if (shape.actions?.click !== undefined) out.push(shape.actions.click)

				for (const paragraph of shape.text?.paragraphs ?? [])
					for (const run of paragraph.runs)
						if (run.kind !== "opaque" && run.rPr.hlinkClick !== undefined) out.push(run.rPr.hlinkClick)

				collect(shape.children ?? [], out)
			}
		}

		for (const entry of opened) {
			const out: Action[] = []

			for (const ref of entry.deck.slides) collect(node(entry.deck, ref)?.shapes ?? [], out)
			if (out.length > 0) actions.set(entry.path, out)
		}

		expect(actions.get("odp/tika__testODPMacro.odp")).toEqual([
			{ kind: "refused", what: "script", raw: "vnd.sun.star.script:Standard.testmodule.Main?language=Basic&location=document" }
		])
		expect(actions.get("odp/lo__textbox-link-javascript.odp")).toEqual([
			{ kind: "refused", what: "scheme", raw: "javascript:alert(1);" }
		])
		expect([...actions.values()].flat().filter(action => action.kind === "url").length).toBeGreaterThanOrEqual(10)
	})

	describe.skipIf(CACHE === undefined)("against LibreOffice 7.5", () => {
		it("has the page count of every deck LibreOffice opens", { timeout: 300_000 }, async () => {
			const { opened } = await corpus()
			let compared = 0

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				compared++
				expect(entry.deck.slides.length, entry.path).toBe(lo.slides.length)
				expect(
					entry.deck.slides.map(ref => node(entry.deck, ref)?.hidden),
					entry.path
				).toEqual(lo.slides.map(slide => slide.hidden))
			}

			expect(compared).toBeGreaterThanOrEqual(PRESENT.length - 1)
		})

		it("places ≥ 97% of shapes within 50 (1/100 mm) of LibreOffice", { timeout: 300_000 }, async ({ task }) => {
			const { opened } = await corpus()
			let total = 0
			let within = 0
			let rotations = 0
			let unaligned = 0
			const missed = new Map<string, number>()
			const misses: string[] = []
			const turned: string[] = []

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				entry.deck.slides.forEach((ref, index) => {
					const pairs = align(node(entry.deck, ref), lo.slides?.[index]?.shapes ?? [])

					if (pairs === undefined) {
						unaligned++

						return
					}

					for (const [shape, theirs] of pairs) {
						if (shape.xfrm === undefined || theirs.box100mm === undefined) continue

						const uno = unoBox(shape.xfrm)
						const ok = uno.box.every((value, at) => Math.abs(value - (theirs.box100mm?.[at] ?? Number.NaN)) <= 50)

						total++

						if (ok) within++
						else {
							missed.set(entry.path, (missed.get(entry.path) ?? 0) + 1)
							misses.push(
								`${entry.path} #${String(index + 1)} ${shape.name}: ${uno.box.map(Math.round).join(",")} vs ${theirs.box100mm.join(",")}`
							)
						}

						// UNO turns lines and groups where we flip lines and turn a group's members.
						if (typeof theirs.rot === "number" && theirs.rot !== 0 && shape.kind !== "cxnSp" && shape.kind !== "grpSp") {
							rotations++

							if (Math.abs(((uno.rot - theirs.rot + 54_000) % 36_000) - 18_000) > 5)
								turned.push(
									`${entry.path} #${String(index + 1)} ${shape.name}: ${String(uno.rot)} vs ${String(theirs.rot)} flip ${String(shape.xfrm.flipH)}/${String(shape.xfrm.flipV)}`
								)
						}
					}
				})
			}

			Object.assign(task.meta, { boxes: { total, within, rotations, unaligned, misses, turned } })
			expect(turned).toEqual([])
			expect(unaligned).toBe(0)
			expect(total).toBeGreaterThan(7000)
			expect(within / total).toBeGreaterThanOrEqual(0.97)
			expect(rotations).toBeGreaterThanOrEqual(12)
			expect(Object.fromEntries(missed)).toEqual(EXPECTED_MISSES)
		})

		it("has the text of ≥ 99% of shapes", { timeout: 300_000 }, async ({ task }) => {
			const { opened } = await corpus()
			let total = 0
			let equal = 0
			const misses: string[] = []

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				entry.deck.slides.forEach((ref, index) => {
					for (const [shape, theirs] of align(node(entry.deck, ref), lo.slides?.[index]?.shapes ?? []) ?? []) {
						if (theirs.text === undefined && shape.text === undefined) continue

						total++

						if (sameText(plain(shape), theirs.text ?? "")) equal++
						else misses.push(`${entry.path} #${String(index + 1)} ${shape.name}`)
					}
				})
			}

			Object.assign(task.meta, { text: { total, equal, misses } })
			expect(total).toBeGreaterThan(2500)
			expect(equal / total).toBeGreaterThanOrEqual(0.99)
		})

		it("has the notes text of every page", { timeout: 300_000 }, async ({ task }) => {
			const { opened } = await corpus()
			let total = 0
			let equal = 0

			for (const entry of opened) {
				const lo = oracle(entry)

				if (lo?.slides === undefined) continue

				entry.deck.slides.forEach((ref, index) => {
					const notes = node(entry.deck, node(entry.deck, ref)?.notes)
					const ours = (notes?.shapes ?? [])
						.filter(shape => shape.ph?.type === "body")
						.map(plain)
						.join("\n")
					const theirs = lo.slides?.[index]?.notes ?? []

					if (normalise(ours) === "" && theirs.every(text => /^(<number>|\d+)?$/u.test(normalise(text)))) return

					total++
					if (theirs.some(text => sameText(ours, text))) equal++
				})
			}

			Object.assign(task.meta, { notes: { total, equal } })
			expect(total).toBeGreaterThan(10)
			expect(equal).toBe(total)
		})
	})
})

// Pairs our page shapes with LibreOffice's, in z-order. A master's footers shown on the slide are ours alone (UNO
// keeps them on the master).
function align(slide: SlideNode | undefined, theirs: readonly LoShape[]): [ShapeNode, LoShape][] | undefined {
	if (slide === undefined) return undefined

	const ours = slide.shapes.filter(shape => shape.synthetic !== true)

	if (ours.length !== theirs.length) return undefined

	return ours.map((shape, at) => [shape, theirs[at] as LoShape])
}
