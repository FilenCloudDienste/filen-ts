import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Slice } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { DocxEditorSession } from "@filen/office/core/docx/edit"
import { ReviewIndex } from "../core/docx/review/index"
import { CORPUS_DIR as CORPUS } from "./corpusDir"
import { openBytes } from "./docxEditFixtures"

// The review index kept up edit by edit equals a fresh scan, over corpus documents with comments and tracked
// changes: typing, deleting, pasting, splitting, joining, formatting, undo and redo.

const DIR = join(CORPUS, "docx")
const REVIEWED = [
	"docx4j__loadAndSave.docx",
	"lo__TC-table-DnD-move.docx",
	"lo__fdo79668.docx",
	"lo__redline-range-comment.docx",
	"lo__tdf104797.docx",
	"lo__tdf123054.docx",
	"lo__tdf151954.docx",
	"lo__tdf61000.docx",
	"lo__wDateValueFormat.docx",
	"oxpt__HC031-Complicated-Document.docx",
	"oxpt__RA001-Tracked-Revisions-01.docx",
	"oxpt__RA001-Tracked-Revisions-02.docx",
	"oxpt__RP015-MoveFrom-MoveTo.docx",
	"oxsdk__Comment025.docx",
	"oxsdk__Comment028.docx",
	"oxsdk__Comment045.docx",
	"oxsdk__trackChange.docx"
]
const STEPS = 120

function rng(seed: number): () => number {
	let a = seed >>> 0

	return () => {
		a = (a + 0x6d2b79f5) >>> 0

		let t = a

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function textPositions(session: DocxEditorSession): number[] {
	const out: number[] = []

	session.state.doc.descendants((node, pos) => {
		if (node.isTextblock) {
			for (let k = 1; k < node.nodeSize - 1; k++) out.push(pos + k)

			out.push(pos + 1)

			return false
		}

		return true
	})

	return out
}

function difference(session: DocxEditorSession, random: () => number): string | undefined {
	const index = session.reviewIndex
	const fresh = new ReviewIndex(session.state.doc)
	const kept = JSON.stringify(index.entries())
	const scanned = JSON.stringify(fresh.entries())

	if (kept !== scanned) {
		const mine = index.entries().map(entry => JSON.stringify(entry))
		const theirs = fresh.entries().map(entry => JSON.stringify(entry))

		return `entries: only kept ${mine.filter(entry => !theirs.includes(entry)).join(" ")}; only scanned ${theirs.filter(entry => !mine.includes(entry)).join(" ")}`
	}
	if (index.commentCount !== fresh.commentCount) return `comments ${index.commentCount} vs ${fresh.commentCount}`
	if (index.revisionCount !== fresh.revisionCount) return `revisions ${index.revisionCount} vs ${fresh.revisionCount}`

	const size = session.state.doc.content.size
	const from = Math.floor(random() * (size + 1))
	const to = Math.min(size + 1, from + Math.floor(random() * 200))

	if (JSON.stringify(index.between(from, to)) !== JSON.stringify(fresh.between(from, to))) return `between(${from}, ${to})`

	return undefined
}

function edit(session: DocxEditorSession, random: () => number): string {
	const positions = textPositions(session)

	if (positions.length === 0) return "none"

	const at = positions[Math.floor(random() * positions.length)] ?? 1
	const state = session.state
	const size = state.doc.content.size
	const choice = random()
	const to = Math.min(size - 1, at + 1 + Math.floor(random() * (random() < 0.2 ? 400 : 20)))
	const select = (): typeof state.tr => {
		try {
			return state.tr.setSelection(TextSelection.create(state.doc, at, to))
		} catch {
			return state.tr
		}
	}

	if (choice < 0.3) {
		session.dispatch(state.tr.insertText(random() < 0.5 ? "w" : "word ", at))

		return `type@${at}`
	}

	if (choice < 0.5) {
		session.dispatch(select().deleteSelection())

		return `delete ${at}-${to}`
	}

	if (choice < 0.6) {
		const x = positions[Math.floor(random() * positions.length)] ?? 1
		const y = Math.min(size, x + Math.floor(random() * 300))
		let slice: Slice

		try {
			slice = state.doc.slice(Math.min(x, y), Math.max(x, y))
			session.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).replaceSelection(slice))
		} catch {
			return "paste refused"
		}

		return `paste ${x}-${y}@${at}`
	}

	try {
		if (choice < 0.68) {
			session.dispatch(state.tr.split(at))

			return `split@${at}`
		}

		if (choice < 0.74) {
			const $at = state.doc.resolve(at)

			if ($at.depth >= 1) session.dispatch(state.tr.join($at.before()))

			return `join@${at}`
		}
	} catch {
		return "refused"
	}

	if (choice < 0.8) {
		session.dispatch(select())

		const types = ["format.bold", "format.clear", "list.bullet", "list.indent", "align.center"] as const
		const type = types[Math.floor(random() * types.length)] ?? "format.bold"

		session.execute({ type })

		return `${type} ${at}-${to}`
	}

	session.execute({ type: choice < 0.9 ? "history.undo" : "history.redo" })

	return choice < 0.9 ? "undo" : "redo"
}

describe.skipIf(!existsSync(DIR))("docx review index over the corpus", () => {
	it("equals a fresh scan after every edit", { timeout: 300_000 }, async () => {
		const all = readdirSync(DIR)
			.filter(name => name.endsWith(".docx"))
			.sort()
		const pick = rng(99)
		const files = REVIEWED.filter(name => all.includes(name))

		// Eight more, drawn without replacement (a seeded partial shuffle), so a small corpus ends the draw.
		const pool = all.filter(name => !files.includes(name))
		const extra = Math.min(8, pool.length)

		for (let k = 0; k < extra; k++) {
			const at = k + Math.floor(pick() * (pool.length - k))
			const name = pool[at] ?? ""

			pool[at] = pool[k] ?? ""
			pool[k] = name
			files.push(name)
		}

		const problems: string[] = []
		// REVIEWED documents the gate let through: a gate that starts refusing them all must not pass unchecked.
		let checked = 0

		for (const file of files) {
			const opened = await openBytes(new Uint8Array(readFileSync(join(DIR, file))))

			if (opened.context.gate.length > 0) continue

			if (REVIEWED.includes(file)) checked++

			// Made before the first edit, and made after some edits (it starts from that document).
			for (const [seed, touch] of [
				[1, 0],
				[3, 40]
			] as const) {
				const session = new DocxEditorSession(opened.context)
				const random = rng(seed)
				const log: string[] = []

				if (touch === 0) expect(session.reviewIndex.size).toBeGreaterThanOrEqual(0)

				for (let step = 0; step < STEPS; step++) {
					log.push(edit(session, random))

					if (step + 1 < touch) continue

					const problem = difference(session, random)

					if (problem !== undefined) {
						problems.push(`${file} seed ${seed} step ${step} [${log.slice(-4).join(" | ")}] ${problem}`)

						break
					}
				}
			}
		}

		expect(problems).toEqual([])

		if (files.length > extra) expect(checked).toBeGreaterThan(0)
	})
})
