import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { partsOf } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"
import { budget } from "./timing"

// Every ODP deck of the corpus brought to one state (a shape moved and flipped, notes, a slide duplicated, a picture
// inserted, a comment, the last slide deleted), saved, undone to the start, saved, redone to that state and saved
// again: the last save writes every part as the first did, byte for byte (a pretty-printed page's whitespace, the
// automatic styles' names, the ids a duplicated page gets and the order of attributes included).

const DIRECTORY = join(CORPUS_DIR, "odp")
const FILES = existsSync(DIRECTORY)
	? readdirSync(DIRECTORY)
			.filter(name => name.endsWith(".odp"))
			.sort()
	: []
const BOX = { x: 1_000_000, y: 1_000_000, cx: 2_000_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false }

// Decks left out of the comparison, by file, with why (a deck that fails to open, applies none of the edits or does not
// save the state): none today, so a deck that starts to fail is named.
const EXPECTED_SKIPS: Readonly<Record<string, string>> = {}

// The edits a deck refuses, by file, each explained (the deck still saves the state the other edits make):
//   - the first slide's first shape with a box is a frame (a chart or an object), which cannot be flipped: BarChartVeryLongLabel,
//     custom_legend_position, fdo71075, formated_axis_lines, multiple_categories, tdf53970 and tdf53970_linked;
//   - rotate_flip: the first slide's first shape is locked against moving.
const FRAME_FLIP = ["shape setXfrm: unsupported"]
const EXPECTED_REFUSALS: Readonly<Record<string, readonly string[]>> = {
	"lo__BarChartVeryLongLabel.odp": FRAME_FLIP,
	"lo__custom_legend_position.odp": FRAME_FLIP,
	"lo__fdo71075.odp": FRAME_FLIP,
	"lo__formated_axis_lines.odp": FRAME_FLIP,
	"lo__multiple_categories.odp": FRAME_FLIP,
	"lo__rotate_flip.odp": ["shape setXfrm: locked"],
	"lo__tdf53970.odp": FRAME_FLIP,
	"lo__tdf53970_linked.odp": FRAME_FLIP
}

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

function everyShape(shapes: readonly ShapeNode[], out: ShapeNode[] = []): ShapeNode[] {
	for (const shape of shapes) {
		out.push(shape)

		if (shape.children !== undefined) everyShape(shape.children, out)
	}

	return out
}

// The edits, each as one command: how many applied, and the ones refused (family and kind, with the refusal).
async function edit(d: Awaited<ReturnType<typeof driveSession>>): Promise<{ applied: number; refused: string[] }> {
	const slides = d.session.deck.slides as SlideRef[]
	const first = slides[0] as SlideRef
	const notes = await review(d.context, first, { comments: false })
	const shape = everyShape((d.session.deck.nodes.get(first) as SlideNode).shapes).find(candidate => candidate.xfrm !== undefined)
	const ops: DeckOp[] = []

	if (shape?.xfrm !== undefined)
		ops.push({
			family: "shape",
			kind: "setXfrm",
			target: { slide: first, id: shape.id },
			xfrm: { ...shape.xfrm, x: shape.xfrm.x + 36_000, flipH: !shape.xfrm.flipH }
		})

	ops.push(
		notes.notes === undefined
			? { family: "notes", kind: "setNotes", slide: first, body: plain("same state") }
			: { family: "text", kind: "setText", target: notes.notes, body: plain("same state") },
		{ family: "slide", kind: "duplicate", slide: first },
		{
			family: "picture",
			kind: "insert",
			slide: first,
			shape: { id: 0, name: "P", hidden: false, kind: "pic", xfrm: BOX },
			image: image(12, 7)
		},
		{
			family: "comment",
			kind: "add",
			slide: first,
			comment: { id: "odf:same1", author: "", text: "c", created: "2026-10-28T08:00:00.000Z", anchor: { x: 0, y: 0 } },
			authorName: "Rev"
		}
	)

	if (slides.length > 2) ops.push({ family: "slide", kind: "delete", slides: [slides[slides.length - 1] as SlideRef] })

	let applied = 0
	const refused: string[] = []

	for (const op of ops) {
		const result = await d.command(op)

		if (result.ok) applied++
		else refused.push(`${op.family} ${op.kind}: ${result.refusal}`)
	}

	return { applied, refused }
}

// The parts whose bytes differ between two saves.
async function differing(a: Uint8Array, b: Uint8Array): Promise<string[]> {
	const x = await partsOf(a)
	const y = await partsOf(b)

	return [...new Set([...x.keys(), ...y.keys()])].filter(name => {
		const p = x.get(name)
		const q = y.get(name)

		return p === undefined || q === undefined || !Buffer.from(p).equals(Buffer.from(q))
	})
}

describe.skipIf(FILES.length === 0)("the same ODP state saved after an undo of everything and a redo of everything", () => {
	it("writes the same bytes on every corpus deck that saves the state", { timeout: budget(900_000) }, async () => {
		const different: string[] = []
		const skipped: Record<string, string> = {}
		const refused: Record<string, string[]> = {}
		let written = 0

		for (const name of FILES) {
			let d: Awaited<ReturnType<typeof driveSession>>

			try {
				d = await driveSession(new Uint8Array(readFileSync(join(DIRECTORY, name))), "odp")
			} catch (error) {
				skipped[name] = `open: ${String(error)}`

				continue
			}

			const edited = await edit(d)

			if (edited.refused.length > 0) refused[name] = edited.refused

			if (edited.applied === 0) {
				skipped[name] = "no op applied"

				continue
			}

			const first = await d.save()

			if (first.bytes === undefined) {
				skipped[name] = `first save ${first.result.kind}`

				continue
			}

			for (let k = 0; k < edited.applied; k++) expect((await d.undo()).ok, `${name} undo ${String(k + 1)}`).toBe(true)

			expect((await d.save()).result.kind, name).toBe("written")

			for (let k = 0; k < edited.applied; k++) expect((await d.redo()).ok, `${name} redo ${String(k + 1)}`).toBe(true)

			const again = await d.save()

			if (again.bytes === undefined) different.push(`${name}: ${again.result.kind}`)
			else for (const part of await differing(first.bytes, again.bytes)) different.push(`${name}: ${part}`)

			written++
		}

		expect(skipped).toEqual(EXPECTED_SKIPS)
		expect(refused).toEqual(EXPECTED_REFUSALS)
		expect(written).toBe(FILES.length - Object.keys(EXPECTED_SKIPS).length)
		expect(different).toEqual([])
	})
})
