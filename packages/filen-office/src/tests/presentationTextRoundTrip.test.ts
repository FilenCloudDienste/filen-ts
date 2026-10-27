import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { writeSnapshot } from "../core/pptx/write/save"
import { spliceSnapshot } from "../core/pptx/write/splice"
import { emitPptx } from "../core/pptx/write/emit"
import { findShape } from "../core/presentation/edit/changes"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Paragraph, ParaProps, RunProps, ShapeNode, SlideNode, TextBody } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { findInDeck } from "../dom/presentation/engine/find"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { Changes, changedParts, openDeck, rebaseSession, saveEdits, slideNode, type OpenedDeck } from "./pptxWriteFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { budget } from "./timing"

// Text edits through the pptx writer and back: every run and paragraph property the editor sets reads back as set;
// the text edits of edit set ES3 (type mid-run in a title, bold a range, add a bullet paragraph, replace across
// slides) over every unencrypted OOXML deck of the corpus change only the slides they touch, read back as made, leave
// nothing to save after the save's rebase, and the saved file rewrites byte for byte. With FILEN_OFFICE_PPTX_WRITE_OUT
// set, every output is written there for the Open XML SDK and LibreOffice runs.

const EDIT = { emit: emitPptx } as never
const OUT = process.env["FILEN_OFFICE_PPTX_WRITE_OUT"]
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files.filter(file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path) && file.password === undefined)
const PRESENT = FILES.filter(file => existsSync(join(CORPUS_DIR, file.path)))

const RUN_CASES: readonly (readonly [string, RunProps])[] = [
	["size", { sz: 3200 }],
	["bold", { b: true }],
	["italic", { i: true }],
	["underline", { u: "dbl" }],
	["wavy underline", { u: "wavyHeavy" }],
	["strike", { strike: "sngStrike" }],
	["double strike", { strike: "dblStrike" }],
	["superscript", { baseline: 30000 }],
	["subscript", { baseline: -25000 }],
	["all caps", { cap: "all" }],
	["small caps", { cap: "small" }],
	["spacing", { spc: 300 }],
	["kerning", { kern: 1200 }],
	["latin font", { latin: { typeface: "Georgia" } }],
	["east asian font", { ea: { typeface: "MS Gothic" } }],
	["colour", { fill: { kind: "solid", color: { kind: "srgb", rgb: "C00000" } } }],
	["theme colour", { fill: { kind: "solid", color: { kind: "scheme", slot: "accent2" } } }],
	["highlight", { highlight: { kind: "srgb", rgb: "FFFF00" } }],
	["url link", { hlinkClick: { kind: "url", href: "https://filen.io/" } }],
	["mail link", { hlinkClick: { kind: "url", href: "mailto:support@filen.io" } }],
	["next slide link", { hlinkClick: { kind: "internal", jump: "next" } }]
]

const PARA_CASES: readonly (readonly [string, ParaProps])[] = [
	["centred", { algn: "ctr" }],
	["right", { algn: "r" }],
	["justified", { algn: "just" }],
	["distributed", { algn: "dist" }],
	["level 3", { lvl: 2 }],
	["indents", { marL: 457200, indent: -228600 }],
	["right indent", { marR: 114300 }],
	["line spacing", { lnSpc: { pct: 150000 } }],
	["exact line spacing", { lnSpc: { pts: 2400 } }],
	["space before and after", { spcBef: { pts: 1200 }, spcAft: { pct: 50000 } }],
	["bullet", { bullet: { kind: "char", char: "•" }, marL: 342900, indent: -342900 }],
	["numbering", { bullet: { kind: "autoNum", scheme: "romanUcPeriod", startAt: 3 } }],
	["no bullet", { bullet: { kind: "none" } }],
	["bullet colour and size", { bullet: { kind: "char", char: "▪" }, buClr: { kind: "srgb", rgb: "2F5597" }, buSz: { pct: 75000 } }],
	["bullet font", { bullet: { kind: "char", char: "§" }, buFont: { typeface: "Wingdings" } }],
	["right to left", { rtl: true }],
	[
		"tab stops",
		{
			tabs: [
				{ pos: 914400, algn: "l" },
				{ pos: 2743200, algn: "dec" }
			]
		}
	],
	["default tab", { defTabSz: 457200 }],
	["font alignment", { fontAlgn: "ctr" }]
]

function fixture(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Text properties"))) +
					sp(
						3,
						"Box",
						undefined,
						`${xfrm(100, 200, 6000000, 4000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("x"))
					)
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Second"))) }
		]
	})
}

function propertyBody(): TextBody {
	const paragraphs: Paragraph[] = [
		...RUN_CASES.map(([name, rPr]): Paragraph => ({
			pPr: {},
			runs: [
				{ kind: "r", text: `${name}: `, rPr: { lang: "en-GB" } },
				{ kind: "r", text: name, rPr: { lang: "en-GB", ...rPr } }
			]
		})),
		...PARA_CASES.map(([name, pPr]): Paragraph => ({ pPr, runs: [{ kind: "r", text: name, rPr: { lang: "en-GB" } }] })),
		{
			pPr: {},
			runs: [
				{ kind: "r", text: "a", rPr: { lang: "en-GB" } },
				{ kind: "br", rPr: { lang: "en-GB", sz: 2000 } },
				{ kind: "r", text: "b", rPr: { lang: "en-GB" } }
			],
			endRPr: { lang: "en-GB", sz: 2400 }
		}
	]

	return { bodyPr: { wrap: true, anchor: "ctr", columns: 2, columnSpacing: 12 }, paragraphs }
}

function shapeOn(node: SlideNode, id: number): ShapeNode {
	const shape = findShape(node.shapes, id)?.shape

	if (shape === undefined) throw new Error(`no shape ${String(id)}`)

	return shape
}

function allDirty(opened: OpenedDeck): Changes {
	const changes = new Changes()

	for (const node of opened.deck.nodes.values()) {
		if (node.kind !== "slide" && node.kind !== "layout" && node.kind !== "master") continue

		changes.slide(node.part, { kind: "node" })
		for (const shape of node.shapes) changes.shape(node.part, shape.id, { kind: "node" })
	}

	return changes
}

// A rewrite of `bytes` with every node marked dirty and no ops: the bytes again (the writer's fixed point).
async function rewritesIdentically(bytes: Uint8Array): Promise<boolean> {
	const opened = await openDeck(bytes)

	for (let index = 0; index < opened.deck.slides.length; index++) slideNode(opened, index)

	const snapshot = await spliceSnapshot({ deck: opened.deck, source: opened.source, changes: allDirty(opened).build(), revision: 1 })

	if (snapshot.kind === "refused") return false

	const sink = memorySink()
	const outcome = await writeSnapshot(snapshot, sink)
	const out = sink.bytes()

	return outcome.kind === "written" && out.length === bytes.length && out.every((byte, index) => byte === bytes[index])
}

function revisionOf(result: Awaited<ReturnType<EditHarness["command"]>>): number {
	if (!result.ok) throw new Error(`refused: ${result.refusal}`)

	return result.revision
}

describe("presentation text through the pptx writer", () => {
	it("every run and paragraph property the editor sets reads back as set", async () => {
		const bytes = fixture()
		const h = await editHarness(bytes, EDIT)
		const slide = await h.slide(0)
		const target = { slide: slide.ref, id: 3 }
		const set = propertyBody()
		const revision = revisionOf(await h.command({ family: "text", kind: "setText", target, body: set }))
		const saved = await saveEdits(h, revision)

		// The links' relationships go with the slide.
		expect(await changedParts(bytes, saved)).toEqual(["ppt/slides/slide1.xml", "ppt/slides/_rels/slide1.xml.rels"])

		const back = await openDeck(saved)
		const read = shapeOn(slideNode(back, 0), 3).text as TextBody

		expect(read.bodyPr).toMatchObject({ wrap: true, anchor: "ctr", columns: 2 })

		RUN_CASES.forEach(([name, rPr], index) => {
			const run = read.paragraphs[index]?.runs[1]

			expect(run?.kind === "r" ? run.rPr : undefined, name).toEqual({ lang: "en-GB", ...rPr })
		})
		PARA_CASES.forEach(([name, pPr], index) => {
			expect(read.paragraphs[RUN_CASES.length + index]?.pPr, name).toEqual(pPr)
		})
		expect(read.paragraphs.at(-1)?.runs.map(run => run.kind)).toEqual(["r", "br", "r"])
		expect(read.paragraphs.at(-1)?.endRPr).toEqual({ lang: "en-GB", sz: 2400 })

		// Nothing left to save once the save is the base; the saved file rewrites byte for byte.
		await rebaseSession(h, bytes, saved)
		expect(sessionEdits(h.session).changes().empty).toBe(true)
		expect(await rewritesIdentically(saved)).toBe(true)

		if (OUT !== undefined) {
			mkdirSync(OUT, { recursive: true })
			writeFileSync(join(OUT, "text__properties.pptx"), saved)
		}

		h.close()
	})
})

// The first text run of at least `length` characters on a shape of `node` that `pick` accepts.
function runOn(
	node: SlideNode,
	pick: (shape: ShapeNode) => boolean,
	length: number
): { shape: ShapeNode; paragraph: number; run: number } | undefined {
	const visit = (shapes: readonly ShapeNode[]): { shape: ShapeNode; paragraph: number; run: number } | undefined => {
		for (const shape of shapes) {
			if (shape.children !== undefined) {
				const inner = visit(shape.children)

				if (inner !== undefined) return inner
			}

			if (shape.kind !== "sp" || shape.lock !== undefined || shape.text === undefined || !pick(shape)) continue

			for (let p = 0; p < shape.text.paragraphs.length; p++) {
				const runs = shape.text.paragraphs[p]?.runs ?? []

				for (let r = 0; r < runs.length; r++) {
					const run = runs[r]

					if (run?.kind === "r" && run.text.length >= length && !/[\ud800-\udfff]/u.test(run.text.slice(0, 4)))
						return { shape, paragraph: p, run: r }
				}
			}
		}

		return undefined
	}

	return visit(node.shapes)
}

function withRun(body: TextBody, paragraph: number, run: number, replace: (text: string, rPr: RunProps) => Paragraph["runs"]): TextBody {
	const paragraphs = body.paragraphs.map((item, p) => {
		if (p !== paragraph) return item

		const runs = item.runs.flatMap((candidate, r) =>
			r === run && candidate.kind === "r" ? replace(candidate.text, candidate.rPr) : [candidate]
		)

		return { ...item, runs }
	})

	return { ...body, paragraphs }
}

const MARK = "Qzv"
const REPLACED = "Replaced"

describe.skipIf(PRESENT.length === 0)("text edit set ES3 over the corpus", () => {
	it(
		"types, bolds, adds a bullet paragraph and replaces across slides: only touched slides change, all reads back",
		{ timeout: budget(600_000) },
		async ({ task }) => {
			const failures: string[] = []
			let edited = 0
			let replacedDecks = 0

			if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

			for (const file of PRESENT) {
				const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
				const h = await editHarness(bytes, EDIT)
				const path = file.path

				try {
					const deck = h.session.deck

					if (deck.gate.length > 0) continue

					const parts = pptxParts(deck)
					const touched = new Set<string>()
					const ops: DeckOp[] = []
					let typedSlide = -1

					for (let index = 0; index < deck.slides.length && ops.length < 3; index++) {
						const ref = deck.slides[index]

						if (ref === undefined || parts === undefined) continue

						const node = await parts.slide(ref)
						const title =
							ops.length === 0
								? runOn(node, shape => shape.ph?.type === "title" || shape.ph?.type === "ctrTitle", 2)
								: undefined

						if (title !== undefined) {
							// Type mid-run in a title.
							const next = withRun(title.shape.text as TextBody, title.paragraph, title.run, (text, rPr) => [
								{ kind: "r", text: `${text.slice(0, 1)}${MARK}${text.slice(1)}`, rPr }
							])

							ops.push({ family: "text", kind: "setText", target: { slide: ref, id: title.shape.id }, body: next })
							touched.add(node.part.slice(1))
							typedSlide = index

							continue
						}

						const other = runOn(node, shape => shape.ph?.type !== "title" && shape.ph?.type !== "ctrTitle", 3)

						if (other === undefined || index === typedSlide) continue

						// Bold a range, and a bullet paragraph after it.
						let next = withRun(other.shape.text as TextBody, other.paragraph, other.run, (text, rPr) => [
							{ kind: "r", text: text.slice(0, 1), rPr },
							{ kind: "r", text: text.slice(1, 3), rPr: { ...rPr, b: true } },
							...(text.length > 3 ? [{ kind: "r" as const, text: text.slice(3), rPr }] : [])
						])

						next = {
							...next,
							paragraphs: [
								...next.paragraphs,
								{
									pPr: { marL: 342900, indent: -342900, bullet: { kind: "char", char: "•" } },
									runs: [{ kind: "r", text: `Point ${MARK}`, rPr: { lang: "en-GB" } }]
								}
							]
						}
						ops.push({ family: "text", kind: "setText", target: { slide: ref, id: other.shape.id }, body: next })
						touched.add(node.part.slice(1))
					}

					if (ops.length === 0) continue

					let revision = 0

					for (const op of ops) {
						const result = await h.command(op)

						if (!result.ok) {
							failures.push(`${path}: ${op.kind} refused ${result.refusal}`)
							revision = -1
							break
						}

						revision = result.revision
					}

					if (revision < 0) continue

					// Replace across slides: every match of the mark, one step.
					const found = await findInDeck(h.context, MARK, { caseSensitive: true, scope: ["slides"] })
					const targets = new Map<string, { target: { slide: (typeof deck.slides)[number]; id: number } }>()

					for (let at = 0; at < found.length; at += 6) {
						const ref = deck.slides[found[at] ?? -1]

						if (ref !== undefined)
							targets.set(`${String(ref)}:${String(found[at + 1])}`, { target: { slide: ref, id: found[at + 1] ?? 0 } })
					}

					const slidesWithMark = new Set([...targets.values()].map(entry => entry.target.slide)).size

					if (targets.size > 0) {
						const replaced = await h.command({
							family: "text",
							kind: "replace",
							query: MARK,
							replacement: REPLACED,
							caseSensitive: true,
							targets: [...targets.values()]
						})

						if (!replaced.ok) {
							failures.push(`${path}: replace refused ${replaced.refusal}`)
							continue
						}

						revision = replaced.revision

						if (slidesWithMark > 1) replacedDecks++
					}

					const saved = await saveEdits(h, revision)
					const changed = (await changedParts(bytes, saved)).filter(name => !name.startsWith("docProps/"))

					if (changed.some(name => !touched.has(name)))
						failures.push(`${path}: changed ${changed.join(", ")} for ${[...touched].join(", ")}`)

					const back = await openDeck(saved)
					let marks = 0
					let replacements = 0

					const count = (shapes: readonly ShapeNode[]): void => {
						for (const shape of shapes) {
							if (shape.children !== undefined) count(shape.children)

							for (const paragraph of shape.text?.paragraphs ?? []) {
								const text = paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join("")

								if (text.includes(MARK)) marks++
								if (text.includes(REPLACED)) replacements++
							}
						}
					}

					for (let index = 0; index < back.deck.slides.length; index++) count(slideNode(back, index).shapes)

					if (marks > 0 || replacements !== targets.size)
						failures.push(
							`${path}: ${String(marks)} marks left, ${String(replacements)} replacements for ${String(targets.size)}`
						)

					await rebaseSession(h, bytes, saved)

					if (!sessionEdits(h.session).changes().empty) failures.push(`${path}: changes left after the rebase`)
					if (!(await rewritesIdentically(saved))) failures.push(`${path}: the saved file does not rewrite byte for byte`)
					if (OUT !== undefined) writeFileSync(join(OUT, `es3__${basename(path)}`), saved)

					edited++
				} catch (error) {
					failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
				} finally {
					h.close()
				}
			}

			Object.assign(task.meta, { corpus: { decks: PRESENT.length, edited, replacedAcrossSlides: replacedDecks, failures } })
			expect(failures).toEqual([])
			expect(edited).toBeGreaterThan(100)
		}
	)
})
