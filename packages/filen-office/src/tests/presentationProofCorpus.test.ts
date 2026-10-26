import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openPptx } from "../core/pptx/package"
import { proveSlide } from "../core/presentation/edit/proof"
import type { LockReason } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"
import { readCorpusList } from "./oracles/presentation/corpus"

// Proof gate 1 over the corpus: every source shape of every slide of every editable OOXML deck is written by the
// pptx emitters as if dirty and compared with its source by meaning; at most 2% of shapes lock, each lock counted
// under its reason. Shapes of a family whose emitter is not built yet (refused notImplemented) are counted apart:
// they lock until it is.

const OOXML = /\.(?:pptx|pptm|potx|potm|ppsx|ppsm)$/iu
const MANIFEST = join(import.meta.dirname, "..", "..", "corpus", "manifest.json")
const files = existsSync(CORPUS_DIR) && existsSync(MANIFEST) ? readCorpusList(MANIFEST).filter(entry => OOXML.test(entry.path)) : []

describe.skipIf(files.length === 0)("proof gate 1 over the corpus", () => {
	it("locks at most 2% of shapes, each lock counted by reason", async ({ task }) => {
		let shapes = 0
		let decks = 0
		const locked: Partial<Record<LockReason, number>> = {}
		const failures: Record<string, number> = {}
		const worst: { file: string; locked: number; shapes: number }[] = []

		for (const entry of files) {
			const path = join(CORPUS_DIR, entry.path)

			if (!existsSync(path)) continue

			const opened = await openPptx(bytesSource(new Uint8Array(readFileSync(path))))

			// Encrypted, refused and view-only decks are never edited.
			if (opened.kind !== "opened" || opened.deck.gate.length > 0) continue

			decks++

			let deckShapes = 0
			let deckLocked = 0

			for (const ref of opened.deck.slides) {
				let slide

				try {
					slide = await opened.parts.slide(ref)
				} catch {
					continue
				}

				const document = opened.parts.document(slide.part)

				if (document === undefined) continue

				const tally = proveSlide({
					deck: opened.deck,
					slide,
					document,
					relationships: await opened.parts.opc.relationships(slide.part.slice(1))
				})

				deckShapes += tally.shapes

				for (const [reason, count] of Object.entries(tally.locked) as [LockReason, number][]) {
					locked[reason] = (locked[reason] ?? 0) + count
					deckLocked += count
				}

				for (const [detail, count] of Object.entries(tally.failures)) failures[detail] = (failures[detail] ?? 0) + count
			}

			shapes += deckShapes
			if (deckLocked > 0) worst.push({ file: entry.path, locked: deckLocked, shapes: deckShapes })
		}

		const total = Object.values(locked).reduce((sum, count) => sum + count, 0)
		const pending = Object.entries(failures)
			.filter(([detail]) => detail.startsWith("refused notImplemented"))
			.reduce((sum, [, count]) => sum + count, 0)
		const rate = shapes === 0 ? 0 : (total - pending) / shapes

		worst.sort((a, b) => b.locked - a.locked)
		Object.assign(task.meta, {
			perf: {
				presentationProofLockRate: { value: rate, budget: 0.02 },
				presentationProofLockRateWithPendingFamilies: { value: shapes === 0 ? 0 : total / shapes },
				presentationProofShapes: { value: shapes },
				presentationProofDecks: { value: decks }
			},
			locks: { byReason: locked, failures, worst: worst.slice(0, 15) }
		})
		expect(decks).toBeGreaterThan(0)
		expect(rate).toBeLessThanOrEqual(0.02)
	}, 900_000)
})
