import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { writeSnapshot } from "../core/pptx/write/save"
import { spliceSnapshot } from "../core/pptx/write/splice"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { budget } from "./timing"
import { emitPptx } from "../core/pptx/write/emit"
import type { SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import {
	Changes,
	applyEs2,
	changedParts,
	danglingReferences,
	openDeck,
	partsOf,
	rebaseSession,
	save,
	saveEdits,
	slideNode,
	text,
	type OpenedDeck
} from "./pptxWriteFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"

// The splice writer over every unencrypted OOXML presentation of the frozen corpus: an untouched save is unchanged,
// a forced rewrite with no ops is byte-identical, a one-shape edit changes only its slide part, and edit set ES2
// passes gate 2 with its edits read back and a second save identical; through the edit session, a slide duplicated
// and its original deleted leaves no dangling reference, and slides added and duplicated by a save are edited and
// saved again after its rebase. With FILEN_OFFICE_PPTX_WRITE_OUT set, every output is written there for the Open XML
// SDK and LibreOffice runs.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files.filter(file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path) && file.password === undefined)
const PRESENT = FILES.filter(file => existsSync(join(CORPUS_DIR, file.path)))
const OUT = process.env["FILEN_OFFICE_PPTX_WRITE_OUT"] || undefined

const EDIT = { emit: emitPptx } as never

async function eachSession(visit: (path: string, bytes: Uint8Array, h: EditHarness) => Promise<void>): Promise<void> {
	for (const file of PRESENT) {
		const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
		const h = await editHarness(bytes, EDIT)

		try {
			if (h.session.deck.gate.length === 0) await visit(file.path, bytes, h)
		} finally {
			h.close()
		}
	}
}

async function each(visit: (path: string, opened: OpenedDeck) => Promise<void>): Promise<void> {
	for (const file of PRESENT) {
		const opened = await openDeck(new Uint8Array(readFileSync(join(CORPUS_DIR, file.path))))

		await visit(file.path, opened)
	}
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

describe.skipIf(PRESENT.length === 0)("pptx splice writer over the corpus", () => {
	it(
		"saves every untouched deck as unchanged and rewrites it byte for byte with no ops",
		{ timeout: budget(300_000) },
		async ({ task }) => {
			const failures: string[] = []
			let rewritten = 0

			await each(async (path, opened) => {
				const unchanged = await save(opened, new Changes().build())

				if (unchanged.outcome.kind !== "unchanged") failures.push(`${path}: untouched save ${unchanged.outcome.kind}`)

				const snapshot = await spliceSnapshot({
					deck: opened.deck,
					source: opened.source,
					changes: allDirty(opened).build(),
					revision: 1
				})

				if (snapshot.kind === "refused") {
					// View-only decks refuse every save in place.
					if (opened.deck.gate.length === 0 || snapshot.reason !== "viewOnly")
						failures.push(`${path}: ${snapshot.reason} ${snapshot.detail ?? ""}`)

					return
				}

				const sink = memorySink()
				const outcome = await writeSnapshot(snapshot, sink)
				const bytes = sink.bytes()

				if (
					outcome.kind !== "written" ||
					bytes.length !== opened.bytes.length ||
					bytes.some((byte, index) => byte !== opened.bytes[index])
				) {
					const changed = [...(snapshot.changes.replace ?? []), ...(snapshot.changes.add ?? [])].map(change => change.name)

					failures.push(
						`${path}: forced rewrite differs (${outcome.kind}${outcome.kind === "refused" ? ` ${outcome.detail ?? ""}` : ""}; ${changed.join(", ")})`
					)
				} else {
					rewritten++
				}
			})

			Object.assign(task.meta, { corpus: { decks: PRESENT.length, rewritten } })
			expect(failures).toEqual([])
			expect(rewritten).toBeGreaterThan(100)
		}
	)

	it("changes only the slide part of a one-shape edit (copies = n − 1)", { timeout: budget(300_000) }, async ({ task }) => {
		const failures: string[] = []
		let edited = 0
		let skipped = 0
		let gated = 0

		await each(async (path, opened) => {
			if (opened.deck.gate.length > 0) {
				gated++

				return
			}

			let target: { node: SlideNode; id: number } | undefined

			// The first unlocked shape of the deck: moved by its xfrm, or given one (an inherited placeholder).
			for (let index = 0; index < opened.deck.slides.length && target === undefined; index++) {
				const node = slideNode(opened, index)
				const shape = node.shapes.find(candidate => candidate.kind !== "opaque" && candidate.lock === undefined)

				if (shape !== undefined) {
					shape.xfrm =
						shape.xfrm === undefined
							? { x: 9525, y: 9525, cx: 952500, cy: 952500, rot: 0, flipH: false, flipV: false }
							: { ...shape.xfrm, x: shape.xfrm.x + 9525 }
					target = { node, id: shape.id }
				}
			}

			if (target === undefined) {
				skipped++

				return
			}

			const { outcome, bytes } = await save(opened, new Changes().shape(target.node.part, target.id, { kind: "xfrm" }).build())

			if (outcome.kind !== "written") {
				failures.push(`${path}: ${outcome.kind} ${outcome.kind === "refused" ? (outcome.detail ?? "") : ""}`)

				return
			}

			const before = await partsOf(opened.bytes)
			const after = await partsOf(bytes)
			const changed = [...after].filter(([name, data]) => text(before.get(name)) !== text(data)).map(([name]) => name)

			if (changed.length !== 1 || changed[0] !== target.node.part.slice(1) || after.size !== before.size)
				failures.push(`${path}: changed ${changed.join(", ")}`)
			else edited++
		})

		Object.assign(task.meta, { corpus: { decks: PRESENT.length, edited, skipped, gated } })
		expect(failures).toEqual([])
		// Every deck with a shape on a slide (the rest have none, or only gated content).
		expect(edited + skipped + gated).toBe(PRESENT.length)
		expect(skipped).toBeLessThanOrEqual(5)
	})

	it(
		"writes edit set ES2 on every deck: gate 2 passes, the edits read back, a second save is identical",
		{ timeout: budget(600_000) },
		async ({ task }) => {
			const failures: string[] = []
			let written = 0

			if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

			await each(async (path, opened) => {
				if (opened.deck.gate.length > 0) return

				const { changes, report } = applyEs2(opened)
				const { outcome, bytes } = await save(opened, changes)

				if (outcome.kind !== "written") {
					failures.push(
						`${path}: ${outcome.kind} ${outcome.kind === "refused" ? `${outcome.reason} ${outcome.detail ?? ""}` : ""}`
					)

					return
				}

				const back = await openDeck(bytes)

				if (back.deck.slides.length !== report.slides)
					failures.push(`${path}: ${String(back.deck.slides.length)} slides, ${String(report.slides)} expected`)

				// A second save of the saved deck, forced with every node dirty, is identical.
				const snapshot = await spliceSnapshot({
					deck: back.deck,
					source: back.source,
					changes: allDirty(back).build(),
					revision: 2
				})

				if (snapshot.kind === "refused") {
					failures.push(`${path}: second save ${snapshot.reason} ${snapshot.detail ?? ""}`)
				} else {
					const sink = memorySink()

					await writeSnapshot(snapshot, sink)

					const again = sink.bytes()

					if (again.length !== bytes.length || again.some((byte, index) => byte !== bytes[index]))
						failures.push(`${path}: second save differs`)
				}

				if (OUT !== undefined) {
					const name = basename(path)

					writeFileSync(join(OUT, `es2__${name}`), bytes)
					writeFileSync(join(OUT, `es2__${name}.json`), JSON.stringify(report))
				}

				written++
			})

			Object.assign(task.meta, { corpus: { decks: PRESENT.length, written } })
			expect(failures).toEqual([])
			expect(written).toBeGreaterThan(100)
		}
	)

	it(
		"duplicates the slide owning the most parts and deletes its original on every deck: nothing dangles",
		{ timeout: budget(600_000) },
		async ({ task }) => {
			const failures: string[] = []
			const skipped: string[] = []
			let written = 0

			await eachSession(async (path, bytes, h) => {
				const deck = h.session.deck
				let pick: SlideRef | undefined
				let best = -1

				for (let index = 0; index < deck.slides.length; index++) {
					const ref = deck.slides[index] ?? (0 as SlideRef)
					const node = await (pptxParts(deck) ?? (undefined as never)).slide(ref)
					const relationships = await (pptxParts(deck) ?? (undefined as never)).opc.relationships(node.part.slice(1))
					const score = relationships.all.filter(relationship =>
						/chart|comment|diagram|notesSlide|image|media|video|audio|package|oleObject/u.test(relationship.type)
					).length

					if (score > best) {
						best = score
						pick = ref
					}
				}

				if (pick === undefined) {
					skipped.push(`${path}: no slide`)

					return
				}

				const original = deck.nodes.get(pick)?.part ?? ""
				const duplicated = await h.command({ family: "slide", kind: "duplicate", slide: pick })

				if (!duplicated.ok) {
					skipped.push(`${path}: duplicate ${JSON.stringify(duplicated)}`)

					return
				}

				const copy = deck.nodes.get(deck.slides[deck.slides.indexOf(pick) + 1] ?? (0 as SlideRef))?.part ?? ""

				const deleted = await h.command({ family: "slide", kind: "delete", slides: [pick] })

				if (!deleted.ok) {
					skipped.push(`${path}: delete ${JSON.stringify(deleted)}`)

					return
				}

				let saved: Uint8Array

				try {
					saved = await saveEdits(h, 1)
				} catch (error) {
					failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)

					return
				}

				// Damage the source already had (carried into the copy under its new name) is the source's.
				const before = new Set(await danglingReferences(bytes))
				const after = (await danglingReferences(saved)).filter(
					problem => !before.has(problem.replaceAll(copy.slice(1), original.slice(1)))
				)

				if (after.length > 0) failures.push(`${path}: ${after.slice(0, 3).join("; ")}`)
				if ((await openDeck(saved)).deck.slides.length !== deck.slides.length) failures.push(`${path}: slide count`)
				if (OUT !== undefined) writeFileSync(join(OUT, `dupdel__${basename(path)}`), saved)

				written++
			})

			Object.assign(task.meta, { corpus: { decks: PRESENT.length, written, skipped } })
			expect(failures).toEqual([])
			// Decks whose edit session refuses the duplicate or the delete (the edit core's verdict, not the writer's).
			expect(skipped.length).toBeLessThanOrEqual(2)
			expect(written).toBeGreaterThan(100)
		}
	)

	it(
		"saves an added and a duplicated slide, rebases onto the saved file, edits both and saves again on every deck",
		{ timeout: budget(600_000) },
		async ({ task }) => {
			const failures: string[] = []
			let written = 0

			await eachSession(async (path, bytes, h) => {
				const deck = h.session.deck
				const first = deck.slides[0]
				const layout = deck.layouts[0]

				if (first === undefined || layout === undefined) return

				await (pptxParts(deck) ?? (undefined as never)).slide(first)

				if (!(await h.command({ family: "slide", kind: "add", at: deck.slides.length, layout })).ok) return
				if (!(await h.command({ family: "slide", kind: "duplicate", slide: first })).ok) return

				const added = [deck.slides[deck.slides.length - 1] ?? (0 as SlideRef), deck.slides[1] ?? (0 as SlideRef)]
				const failed = (step: string, error: unknown): void => {
					failures.push(`${path}: ${step} ${error instanceof Error ? error.message : String(error)}`)
				}
				let saved: Uint8Array

				try {
					saved = await saveEdits(h, 1)
					await rebaseSession(h, bytes, saved)
				} catch (error) {
					failed("first save", error)

					return
				}

				const parts = added.map(ref => deck.nodes.get(ref)?.part.slice(1) ?? "")
				const xfrm: Xfrm = { x: 9525, y: 9525, cx: 952500, cy: 952500, rot: 0, flipH: false, flipV: false }

				for (const ref of added) {
					await h.command({ family: "slide", kind: "hide", slides: [ref], hidden: true })

					const shape = deck.nodes
						.get(ref)
						?.shapes.find(
							candidate => candidate.kind !== "opaque" && candidate.kind !== "grpSp" && candidate.lock === undefined
						)

					if (shape !== undefined)
						await h.command({ family: "shape", kind: "setXfrm", target: { slide: ref, id: shape.id }, xfrm })
				}

				let again: Uint8Array

				try {
					again = await saveEdits(h, 2)
				} catch (error) {
					failed("second save", error)

					return
				}

				const changed = await changedParts(saved, again)

				if (changed.some(name => !parts.includes(name)) || changed.length === 0)
					failures.push(`${path}: second save changed ${changed.join(", ")}`)

				const back = await openDeck(again)

				for (const ref of added) {
					const index = deck.slides.indexOf(ref)

					if (!slideNode(back, index).hidden) failures.push(`${path}: slide ${String(index)} not hidden`)
				}

				if (OUT !== undefined) writeFileSync(join(OUT, `twice__${basename(path)}`), again)

				written++
			})

			Object.assign(task.meta, { corpus: { decks: PRESENT.length, written } })
			expect(failures).toEqual([])
			expect(written).toBeGreaterThan(100)
		}
	)
})
