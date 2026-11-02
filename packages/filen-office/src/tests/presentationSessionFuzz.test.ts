import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { chartEditOp, insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import type { SmartArtInfo } from "../core/smartart/edit"
import { review } from "../dom/presentation/engine/review"
import { smartartCapability } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile, reopened } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"

// Random sessions of edits (pictures, diagrams, charts, notes, comments, moves, slides duplicated, deleted and
// hidden), undo, redo and saves. Every written save is whole and shows what the session shows (modelVsFile); so is the
// save after undoing everything, and the one after redoing everything and letting the history go. FUZZ_SEEDS runs more
// seeds per deck (default 3), FUZZ_FROM another range.

type Drive = Awaited<ReturnType<typeof reopened>>
type Format = "pptx" | "odp"

const SEEDS = Number(process.env["FUZZ_SEEDS"] ?? 3)
const FROM = Number(process.env["FUZZ_FROM"] ?? 1)
const STEPS = 30
const BOX = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
const LAYOUTS = ["picture-caption-list", "process-basic", "venn", "picture-grid", "pyramid-basic"]
const STYLES = ["intense", "moderate", "simple"]
const CELLS = sampleChartCells({ categories: ["A", "B"], series: ["North"] })

function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const notes = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })

function deckOf(name: string): { readonly bytes: Uint8Array; readonly format: Format } | undefined {
	if (name === "synthetic.pptx")
		return {
			format: "pptx",
			bytes: buildPptx({
				slides: [0, 1, 2].map(at => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
				}))
			})
		}
	if (name === "synthetic.odp")
		return {
			format: "odp",
			bytes: odpBytes({
				body: [0, 1, 2]
					.map(
						at =>
							`<draw:page draw:name="P${String(at)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(at)}</text:p></draw:text-box></draw:frame></draw:page>`
					)
					.join("")
			})
		}

	const path = join(CORPUS_DIR, "pptx", name)

	return existsSync(path) ? { format: "pptx", bytes: new Uint8Array(readFileSync(path)) } : undefined
}

// Every relationship resolves and every diagram data names a related drawing (pptx); every picture or medium a page
// names exists and is listed, and every listed entry exists (ODP).
async function whole(bytes: Uint8Array, format: Format): Promise<string[]> {
	if (format === "pptx") return danglingReferences(bytes)

	const zip = await ZipArchive.open(bytesSource(bytes))
	const names = new Set(zip.entries.map(entry => entry.name))
	const text = async (name: string): Promise<string> => {
		const entry = zip.get(name)

		return entry === undefined ? "" : new TextDecoder().decode(await zip.read(entry))
	}
	const manifest = await text("META-INF/manifest.xml")
	const out: string[] = []

	for (const name of ["content.xml", "styles.xml"])
		for (const [, href = ""] of (await text(name)).matchAll(/xlink:href="((?:Pictures|Media)\/[^"]+)"/gu)) {
			if (!names.has(href)) out.push(`${name} names the missing ${href}`)
			if (!manifest.includes(`"${href}"`)) out.push(`the manifest lacks ${href}`)
		}

	return out
}

function shapesOf(shapes: readonly ShapeNode[], out: ShapeNode[] = []): ShapeNode[] {
	for (const shape of shapes) {
		out.push(shape)

		if (shape.children !== undefined) shapesOf(shape.children, out)
	}

	return out
}

// One random step: an op (undefined when none applies here), "undo", "redo" or "save".
async function step(d: Drive, next: () => number, format: Format, n: number): Promise<DeckOp | "undo" | "redo" | "save" | undefined> {
	const slides = d.session.deck.slides
	const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T
	const slide = pick(slides)
	const roll = next()

	await review(d.context, slide)

	const shapes = shapesOf((d.session.deck.nodes.get(slide) as SlideNode).shapes)
	const diagram = shapes.find(shape => shape.frame?.kind === "smartart")
	const chart = shapes.find(shape => shape.frame?.kind === "chart")

	if (roll < 0.08)
		return {
			family: "picture",
			kind: "insert",
			slide,
			shape: { id: 0, name: `Pic${String(n)}`, hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
			image: image(8 + (n % 50), 8)
		}
	if (roll < 0.14) return { family: "slide", kind: "duplicate", slide }
	if (roll < 0.19) return slides.length < 2 ? undefined : { family: "slide", kind: "delete", slides: [slide] }
	if (roll < 0.23) return { family: "slide", kind: "hide", slides: [slide], hidden: next() < 0.5 }
	if (roll < 0.29 && format === "pptx")
		return {
			family: "smartart",
			kind: "insert",
			slide,
			shape: { id: 0, name: `Dia${String(n)}`, hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
			layout: { uniqueId: `urn:filen:smartart:layout:${pick(LAYOUTS)}`, source: "gallery" },
			texts: ["Alpha", "Beta", "Gamma"]
		}
	if (roll < 0.36 && format === "pptx") {
		if (diagram === undefined) return undefined

		const target = { slide, id: diagram.id }

		if (next() < 0.5) {
			const placeholder = ((await smartartCapability.info(d.session, target)) as SmartArtInfo | undefined)?.pictures?.[0]

			return placeholder === undefined
				? undefined
				: {
						family: "smartart",
						kind: "setPicture",
						target,
						node: placeholder.node,
						placeholder: placeholder.placeholder,
						image: image(10 + (n % 30), 10)
					}
		}

		return {
			family: "smartart",
			kind: "setStyle",
			target,
			def: { uniqueId: `urn:filen:smartart:style:${pick(STYLES)}`, source: "gallery" }
		}
	}
	if (roll < 0.41) return insertChartOp(d.session.deck, slide, 0, "column", CELLS)
	if (roll < 0.45) return chart === undefined ? undefined : chartEditOp({ slide, id: chart.id }, { kind: "title", text: `T${String(n)}` })
	if (roll < 0.52) return { family: "notes", kind: "setNotes", slide, body: notes(`Notes ${String(n)}`) }
	if (roll < 0.58)
		return {
			family: "comment",
			kind: "add",
			slide,
			comment: {
				id: format === "odp" ? `odf:fz${String(n)}` : `{${(0x10000000 + n).toString(16)}-7777-4777-8777-777777777777}`,
				author: format === "odp" ? "" : "{22222222-2222-4222-8222-222222222222}",
				text: `c${String(n)}`,
				created: "2026-10-28T08:00:00.000Z",
				anchor: { x: 0, y: 0 }
			},
			authorName: "Fuzz"
		}
	if (roll < 0.66) {
		const moved = shapes.find(shape => shape.xfrm !== undefined)

		return moved?.xfrm === undefined
			? undefined
			: { family: "shape", kind: "setXfrm", target: { slide, id: moved.id }, xfrm: { ...moved.xfrm, x: moved.xfrm.x + 12_700 } }
	}
	if (roll < 0.78) return "undo"
	if (roll < 0.86) return "redo"

	return "save"
}

// The problems of one save: refused, not whole, or not what the session shows.
async function checked(d: Drive, format: Format, when: string): Promise<string[]> {
	const saved = await d.save()

	if (saved.result.kind === "refused") return [`${when}: refused ${JSON.stringify(saved.result)}`]
	if (saved.bytes === undefined) return []

	const broken = await whole(saved.bytes, format)
	const differs = await modelVsFile(d, saved.bytes, format)

	return [...broken.map(problem => `${when}: ${problem}`), ...(differs === "" ? [] : [`${when}: ${differs}`])]
}

const DECKS = ["synthetic.pptx", "lo__tdf149551_SmartArt_Pie.pptx", "lo__smartart-picture-strip.pptx", "synthetic.odp"]
// Seeds that found a fault once, run every time (synthetic.pptx 5066: a diagram restyled on a saved copy, then undone
// to the start and redone, lost its drawing relationship).
const REGRESSIONS: Readonly<Record<string, readonly number[]>> = { "synthetic.pptx": [5066] }

function seedsOf(name: string): number[] {
	const seeds = Array.from({ length: SEEDS }, (_, at) => FROM + at)

	return [...new Set([...seeds, ...(REGRESSIONS[name] ?? [])])]
}

describe("random sessions of edits, undo, redo and saves", () => {
	for (const name of DECKS)
		for (const seed of seedsOf(name))
			it.skipIf(deckOf(name) === undefined)(
				`${name} seed ${String(seed)}: every save whole and as the session shows`,
				{ timeout: 120_000 },
				async () => {
					const { bytes, format } = deckOf(name) as { readonly bytes: Uint8Array; readonly format: Format }
					const d = await reopened(bytes, format)
					const next = random(seed * 7919 + name.length)
					const problems: string[] = []

					for (let n = 0; n < STEPS; n++) {
						const action = await step(d, next, format, n)

						if (action === "undo") await d.undo()
						else if (action === "redo") await d.redo()
						else if (action === "save") problems.push(...(await checked(d, format, `save at step ${String(n)}`)))
						else if (action !== undefined) await d.command(action)
					}

					problems.push(...(await checked(d, format, "last save")))

					let undone = 0

					for (; undone < 600 && (await d.undo()).ok; undone++);

					problems.push(...(await checked(d, format, "undone to the start")))

					for (let redone = 0; redone < undone && (await d.redo()).ok; redone++);

					const first = d.session.deck.slides[0] as SlideRef

					for (let at = 0; at <= 500; at++)
						await d.command({ family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

					problems.push(...(await checked(d, format, "redone, the history let go")))
					expect(problems).toEqual([])
				}
			)
})
