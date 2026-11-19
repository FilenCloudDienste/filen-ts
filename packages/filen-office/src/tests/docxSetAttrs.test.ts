import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Node } from "prosemirror-model"
import { AllSelection } from "prosemirror-state"
import { Step, type StepMap } from "prosemirror-transform"
import { describe, expect, it } from "vitest"
import { DocxEditorSession, docxSchema, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import { AttrChanges, SetAttrsStep } from "../core/docx/edit/attrs"
import { CORPUS_DIR } from "./corpusDir"
import { openBytes, sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"
import { budget } from "./timing"
import { rng as random } from "./mulberry32"

// Paragraph commands set the attributes of every paragraph in one step whatever the selection covers: the same
// document as a step per attribute, an exact undo, and the same mapping as AttrStep.

const nodes = docxSchema.nodes
const TARIFF = join(CORPUS_DIR, "docx", "govuk__Tariff_of_the_United_Kingdom_v1.34.docx")
const cell = (text: string): string => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
const TABLE = `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell("a")}${cell("b")}</w:tr><w:tr>${cell("c")}${cell("d")}</w:tr></w:tbl>`

function paragraphsOf(doc: Node): { node: Node; pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos) => {
		if (node.type === nodes.paragraph) out.push({ node, pos })

		return node.type !== nodes.paragraph
	})

	return out
}

const VALUES: Readonly<Record<string, readonly unknown[]>> = {
	align: [null, "center", "right", "both"],
	styleId: [null, "Heading1", "Quote"],
	indent: [null, { start: 720 }, { start: 360, firstLine: 240 }],
	spacing: [null, { before: 120 }, { line: 360, lineRule: "auto" }]
}

describe("SetAttrsStep", () => {
	it("gives the document a step per attribute gives, inverts exactly, round-trips JSON and maps like AttrStep", async () => {
		const session = await sessionOf({ body: p("one") + p("two") + TABLE + p("three") + TABLE + p("four") })
		const doc = session.state.doc
		const paragraphs = paragraphsOf(doc)
		const next = random(7)
		const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T

		for (let trial = 0; trial < 200; trial++) {
			const batch = session.state.tr
			const sequential = session.state.tr
			const changes = new AttrChanges()

			for (const at of paragraphs) {
				if (next() < 0.5) continue

				const attrs: Record<string, unknown> = {}

				for (const name of Object.keys(VALUES)) if (next() < 0.5) attrs[name] = pick(VALUES[name] ?? [])

				changes.set(at.node, at.pos, attrs)

				for (const [name, value] of Object.entries(attrs))
					if (at.node.attrs[name] !== value) sequential.setNodeAttribute(at.pos, name, value)
			}

			changes.step(batch)
			expect(batch.doc.eq(sequential.doc)).toBe(true)

			const step = batch.steps[0]

			if (!(step instanceof SetAttrsStep)) {
				expect(batch.steps).toHaveLength(0)

				continue
			}

			expect(batch.steps).toHaveLength(1)
			// Blocks without a changed paragraph are kept as they are.
			batch.doc.forEach((block, offset, index) => {
				if (
					!paragraphs.some(
						at => at.pos >= offset && at.pos < offset + block.nodeSize && step.entries.some(entry => entry.pos === at.pos)
					)
				)
					expect(block).toBe(doc.child(index))
			})
			expect(step.invert(doc).apply(batch.doc).doc?.eq(doc)).toBe(true)
			expect((Step.fromJSON(docxSchema, step.toJSON()) as SetAttrsStep).apply(doc).doc?.eq(batch.doc)).toBe(true)

			// Through an edit before, inside or around some of the paragraphs.
			const target = pick(paragraphs)
			const edit = session.state.tr

			if (next() < 0.5) edit.insertText("xy", target.pos + 1)
			else edit.delete(target.pos, target.pos + target.node.nodeSize)

			const map = edit.mapping.maps[0] as StepMap
			const mapped = step.map(map)
			const viaAttr = sequential.steps.map(attr => attr.map(map)).filter((attr): attr is Step => attr !== null)
			let one = edit.doc
			let two = edit.doc

			for (const attr of viaAttr) two = attr.apply(two).doc ?? two

			if (mapped !== null) one = mapped.apply(one).doc ?? one

			expect(one.eq(two)).toBe(true)
		}
	})

	it("is one undo step through a session, which undo and redo restore exactly", async () => {
		const session = await sessionOf({ body: p("one") + TABLE + p("two") + p("three") })
		const before = session.state.doc
		const steps: Step[] = []
		const stop = session.onApplied(transactions => {
			for (const tr of transactions) steps.push(...tr.steps)
		})

		session.dispatch(session.state.tr.setSelection(new AllSelection(before)))
		expect(session.execute({ type: "align.center" })).toBe(true)
		stop()
		expect(steps.filter(step => step instanceof SetAttrsStep)).toHaveLength(1)
		expect(paragraphsOf(session.state.doc).every(at => at.node.attrs["align"] === "center")).toBe(true)

		const after = session.state.doc

		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(before)).toBe(true)
		expect(session.execute({ type: "history.redo" })).toBe(true)
		expect(session.state.doc.eq(after)).toBe(true)
	})

	it("records each paragraph's properties before a tracked change", async () => {
		const session = await sessionOf({ body: p("one") + TABLE + p("two") })

		session.context.identity.author = "Me"
		session.context.review.tracking = true
		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		expect(session.execute({ type: "align.end" })).toBe(true)

		const changed = paragraphsOf(session.state.doc).map(at =>
			at.node.marks.some(mark => mark.type === docxSchema.marks.paragraph_change)
		)

		expect(changed).toEqual(changed.map(() => true))
	})

	it("aligns thousands of paragraphs in one linear step", { timeout: 60_000 }, async () => {
		const session = await sessionOf({ body: Array.from({ length: 8000 }, (_, k) => p(`Paragraph ${String(k)}`)).join("") })

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))

		const steps: Step[] = []
		const stop = session.onApplied(transactions => {
			for (const tr of transactions) steps.push(...tr.steps)
		})
		const start = performance.now()

		expect(session.execute({ type: "align.center" })).toBe(true)
		session.snapshot()

		const ms = performance.now() - start

		stop()
		console.log(`8000 paragraphs align.center ${ms.toFixed(0)} ms`)
		expect(steps).toHaveLength(1)
		// A step per paragraph took 3.3 s here.
		expect(ms).toBeLessThan(budget(1500))
	})
})

describe("paragraph and Clear All Formatting commands over all of a long document", () => {
	const COMMANDS: readonly DocxEditorCommand[] = [
		{ type: "align.center" },
		{ type: "style.set", style: "heading1" },
		{ type: "paragraph.spacing", before: 120, after: 240 },
		{ type: "paragraph.lineSpacing", rule: "auto", value: 360 },
		{ type: "format.clearAll" }
	]

	for (const tracking of [false, true]) {
		it.skipIf(!existsSync(TARIFF))(`runs on Tariff with tracking ${tracking ? "on" : "off"}`, { timeout: 600_000 }, async () => {
			const opened = await openBytes(new Uint8Array(readFileSync(TARIFF)))

			opened.context.identity.author = "Perf"
			opened.context.review.tracking = tracking

			const session = new DocxEditorSession(opened.context)
			const original = session.state.doc
			const times: string[] = []

			session.snapshot()

			for (const command of COMMANDS) {
				session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
				session.snapshot()

				const start = performance.now()

				expect(session.execute(command)).toBe(true)
				session.snapshot()

				const ms = performance.now() - start

				times.push(`${command.type} ${ms.toFixed(0)} ms`)
				// About 1 s untracked, 2 s tracked (a step per paragraph ran out of memory at 3 GB): a generous bound.
				expect(ms).toBeLessThan(budget(tracking ? 15_000 : 5000))
				expect(session.execute({ type: "history.undo" })).toBe(true)
			}

			expect(session.state.doc.eq(original)).toBe(true)
			console.log(`Tariff select-all, tracking ${String(tracking)}: ${times.join(", ")}`)
		})
	}
})
