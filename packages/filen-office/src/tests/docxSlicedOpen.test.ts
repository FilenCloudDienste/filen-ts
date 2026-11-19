import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { parseXml, parseXmlSliced } from "@filen/office/core/xml"
import {
	DocxDocBuilder,
	DocxEditorSession,
	docxSchema,
	proveBlocks,
	proveBlocksSteps,
	storyReviewIndex,
	type BlockProof
} from "@filen/office/core/docx/edit"
import { writerProof } from "@filen/office/core/docx/write"
import type { DocxEngineServices } from "@filen/office/dom/docx"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"
import { buildPart, buildPartSliced, ModelTables } from "../core/docx/model/index"
import { partReader } from "../core/docx/model/reader"
import { prepareReviewIndex } from "../core/docx/review/index"
import { openSpec } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { engineServices } from "./engineFixtures"

// Opening a long document gives the host a turn inside a long table too, at every stage: the model build, the
// editing build, Gate 1 and the review index, each with the same result as at once.

const ROWS = 300

const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const row = (k: number): string => `<w:tr>${cell(`Row ${String(k)} a`)}${cell(k === 150 ? "Row 150 LOCK" : `Row ${String(k)} b`)}</w:tr>`
const TABLE = `<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${Array.from({ length: ROWS }, (_, k) => row(k)).join("")}</w:tbl>`
const BODY =
	p("Before") +
	TABLE +
	'<w:p><w:ins w:id="5" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>' +
	p("After")

// Every slice pauses (sliceMs 0): what one step holds is what one task would.
const EVERY_STEP = { sliceMs: 0, now: () => 0 }

function counting(): { count: number; pause: () => Promise<void> } {
	const pauses = { count: 0, pause: (): Promise<void> => Promise.resolve() }

	pauses.pause = () => {
		pauses.count++

		return Promise.resolve()
	}

	return pauses
}

// Locks the paragraphs whose text says so, and (`table`) the long table; checks a table a row at a time.
function marking(table: boolean): BlockProof {
	const check: BlockProof["check"] = node =>
		node.type === docxSchema.nodes.paragraph
			? node.textContent.includes("LOCK")
				? "proof"
				: undefined
			: table && node.type === docxSchema.nodes.table
				? "proof"
				: undefined

	return {
		check,
		*steps(node, story, due) {
			for (let k = 0; k < node.childCount; k++) if (due()) yield

			return check(node, story)
		}
	}
}

describe("docx open in slices: long tables", () => {
	it("builds the model a row at a time, as at once", async () => {
		const opened = await openSpec({ body: BODY })
		const part = opened.model.partOf(opened.model.body!)
		const reader = partReader(part.document)
		const whole = buildPart(reader, new ModelTables(), 0, part.name, part.relationships)
		const pauses = counting()
		const sliced = await buildPartSliced(reader, new ModelTables(), 0, part.name, part.relationships, {
			...EVERY_STEP,
			pause: pauses.pause
		})

		expect(pauses.count).toBeGreaterThan(ROWS)
		expect(Array.from(sliced.kinds)).toEqual(Array.from(whole.kinds))
		expect(Array.from(sliced.aux)).toEqual(Array.from(whole.aux))
	})

	it("builds the editing document a row at a time, as at once", async () => {
		const opened = await openSpec({ body: BODY })
		const body = opened.model.body!
		const whole = new DocxDocBuilder(opened.context).build(body)
		const pauses = counting()
		const sliced = await new DocxDocBuilder(opened.context).buildSliced(body, pauses.pause, 0, () => 0)

		expect(pauses.count).toBeGreaterThan(ROWS)
		expect(sliced.doc.eq(whole.doc)).toBe(true)
		expect(sliced.stats).toEqual(whole.stats)
	})

	it("proves a table in steps with the verdicts of a proof at once", async () => {
		const opened = await openSpec({ body: BODY })

		for (const table of [false, true]) {
			const session = new DocxEditorSession(opened.context, { proof: null })
			const proof = marking(table)
			const steps = proveBlocksSteps(session.story, session.state.doc, proof, () => true)
			let yields = 0
			let step = steps.next()

			for (; step.done !== true; step = steps.next()) yields++

			expect(yields).toBeGreaterThan(ROWS)
			expect(step.value).toEqual(proveBlocks(session.story, session.state.doc, proof))
			expect(step.value.length).toBe(1)
		}
	})

	it("writes a table for Gate 1 in steps with the verdict of the proof at once", async () => {
		const opened = await openSpec({ body: BODY })
		const session = new DocxEditorSession(opened.context, { proof: null })
		const proof = writerProof(opened.context)
		const table = session.state.doc.child(1)

		expect(table.type).toBe(docxSchema.nodes.table)

		const steps = proof.steps!(table, session.story, () => true)
		let yields = 0
		let step = steps.next()

		for (; step.done !== true; step = steps.next()) {
			// A check meanwhile on the same story is not disturbed by the write in progress.
			if (yields === 10) expect(proof.check(session.state.doc.child(0), session.story)).toBeUndefined()

			yields++
		}

		expect(yields).toBeGreaterThan(ROWS)
		expect(step.value).toBe(proof.check(table, session.story))
		expect(step.value).toBeUndefined()
	})

	it("opens through the in-thread host with the same locks, a turn inside the table", async () => {
		const pauses = counting()
		const services = (): DocxEngineServices => engineServices({ yield: pauses.pause, sliceMs: 0 })
		const editing = inThreadEditingHost(services, { proof: () => marking(false) })
		const handle = editing.host(bytesSource(buildDocx({ body: BODY })), () => undefined)
		const editor = await editing.editor
		const locked: string[] = []

		editor.state.doc.descendants(node => {
			if (node.type === docxSchema.nodes.locked_block) locked.push(String(node.attrs["text"]))

			return node.type !== docxSchema.nodes.locked_block
		})

		expect(editing.proofLocked()).toBe(1)
		expect(locked).toEqual(["Row 150 LOCK"])
		expect(editor.session.snapshot().dirty).toBe(false)
		expect(pauses.count).toBeGreaterThan(ROWS)
		handle.close()
	})
})

describe("docx review index made in slices", () => {
	it("gives the index a scan at once gives, and keeps it up to date", async () => {
		const opened = await openSpec({ body: BODY })
		const session = new DocxEditorSession(opened.context)
		const doc = session.state.doc
		const part = session.story.part
		// The same document's index made at once (the body has no source property change to attach).
		const fresh = storyReviewIndex(new DocxEditorSession(opened.context))
		const pauses = counting()

		expect(await prepareReviewIndex(doc, new Set(), undefined, part, false, { ...EVERY_STEP, pause: pauses.pause }, () => false)).toBe(
			true
		)
		expect(pauses.count).toBeGreaterThan(1)

		const index = storyReviewIndex(session)

		expect(index.sourcesAttached).toBe(true)
		expect(index.entries()).toEqual(fresh.entries())
		expect(index.revisionCount).toBe(1)

		// A tracked insertion typed later is counted.
		opened.context.review.tracking = true
		opened.context.identity.author = "B"
		session.dispatch(session.state.tr.insertText("x", 2))
		expect(storyReviewIndex(session).revisionCount).toBe(2)
	})

	it("stops when the document closes", async () => {
		const opened = await openSpec({ body: BODY })
		const session = new DocxEditorSession(opened.context)
		const part = session.story.part

		expect(
			await prepareReviewIndex(
				session.state.doc,
				new Set(),
				undefined,
				part,
				false,
				{ ...EVERY_STEP, pause: () => Promise.resolve() },
				() => true
			)
		).toBe(false)
	})
})

describe("xml parse in slices", () => {
	it("grows the node arrays to the part's estimated size and copies them in steps", async () => {
		const xml = `<r>${"<a>x</a>".repeat(200_000)}<b>${"<c/>".repeat(100_000)}</b></r>`
		const bytes = new TextEncoder().encode(xml)
		const whole = parseXml(bytes)
		const pauses = counting()
		const sliced = await parseXmlSliced(bytes, { ...EVERY_STEP, pause: pauses.pause })

		expect(sliced.count).toBe(whole.count)
		expect(Array.from(sliced.parents.subarray(0, sliced.count))).toEqual(Array.from(whole.parents.subarray(0, whole.count)))
		expect(Array.from(sliced.nextSiblings.subarray(0, sliced.count))).toEqual(Array.from(whole.nextSiblings.subarray(0, whole.count)))
		expect(pauses.count).toBeGreaterThan(8)
	})
})

describe("docx editor open before background layout", () => {
	it("lays out the first pages, then builds and proves the body before laying out more", { timeout: 60_000 }, async () => {
		const body = Array.from({ length: 3000 }, (_, k) => p(`Paragraph ${String(k)} with a few words in it`)).join("")
		const services = (): DocxEngineServices =>
			engineServices({ yield: () => new Promise(resolve => setImmediate(resolve)), sliceMs: 0 })
		let shipped = 0
		const editing = inThreadEditingHost(services, { proof: writerProof })
		const handle = editing.host(bytesSource(buildDocx({ body })), event => {
			if (event.type === "pages") shipped += event.pages.length
		})
		const editor = await editing.editor
		const pages = editor.layout.pages.length

		// The first screen was there before the editor; little more was laid out meanwhile.
		expect(shipped).toBeGreaterThanOrEqual(3)
		expect(pages).toBeLessThan(8)

		await editor.whenSettled()
		expect(editor.layout.pages.length).toBeGreaterThan(30)
		handle.close()
	})
})
