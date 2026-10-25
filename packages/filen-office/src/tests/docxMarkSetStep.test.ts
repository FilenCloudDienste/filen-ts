import { Slice, type Mark } from "prosemirror-model"
import { TextSelection, type Transaction } from "prosemirror-state"
import { AddMarkStep, RemoveMarkStep, ReplaceStep, type Step } from "prosemirror-transform"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { DocxEditorSession, docxSchema, openDocxEditContext, type DocxEditContext } from "@filen/office/core/docx/edit"
import { FORMS_AFTER, FORMS_BEFORE } from "../core/docx/edit/handlers/forms"
import { REVIEW_TRANSFORMER } from "../core/docx/edit/handlers/review"
import { refusedForForms } from "../core/docx/edit/invariants/forms"
import { markStepPieces, markStepsOf, markStepTypes } from "../core/docx/edit/marks"
import { NO_SOURCE } from "../core/docx/edit/schema"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"

// prosemirror-transform inverts an AddMarkStep displacing a mark of its type (or a RemoveMarkStep over gaps) to a
// MarkSetStep, a class it does not export: an undo of a plain addMark holds one. Whatever reads mark steps by kind
// (protection, tracked formatting, changed ranges) reads it as the mark steps it holds.

const marks = docxSchema.marks

function transformer(tr: Transaction, session: DocxEditorSession): Transaction {
	const before = FORMS_BEFORE(tr, session)

	return FORMS_AFTER(REVIEW_TRANSFORMER?.(before, session) ?? before, session)
}

async function open(spec: SyntheticDocx): Promise<{ context: DocxEditContext; session: DocxEditorSession }> {
	const opened = await openDocxPackage(bytesSource(buildDocx(spec)))

	if (!opened.ok) throw new Error(opened.reason)

	const model = await buildDocxModel(opened.package)
	const context = await openDocxEditContext(opened.package, model, { author: "Ann Lee", clock: () => Date.UTC(2026, 9, 12) })

	return { context, session: new DocxEditorSession(context, { transformer }) }
}

// The text node holding `text`: its start and end, and where `text` starts.
function find(session: DocxEditorSession, text: string): { node: number; at: number; end: number } {
	let found: { node: number; at: number; end: number } | undefined

	session.state.doc.descendants((node, pos) => {
		const index = node.isText ? (node.text?.indexOf(text) ?? -1) : -1

		if (found === undefined && index >= 0) found = { node: pos, at: pos + index, end: pos + node.nodeSize }

		return found === undefined
	})

	if (found === undefined) throw new Error(`no "${text}"`)

	return found
}

const link = (target: string): Mark => marks.link.create({ src: NO_SOURCE, target })

function stepType(step: Step): string {
	return (step.toJSON() as { stepType: string }).stepType
}

const PROTECTED: SyntheticDocx = {
	body:
		p("Fixed text") +
		'<w:p><w:permStart w:id="3" w:edGrp="everyone"/><w:r><w:t>Open linked text</w:t></w:r><w:permEnd w:id="3"/></w:p>',
	settings: '<w:documentProtection w:edit="forms" w:enforcement="1"/>'
}

// Links "linked" to A; [from, to) is its whole line, which a plain addMark of B covers with one AddMarkStep
// displacing A: its inverse is a MarkSetStep.
function linkWord(session: DocxEditorSession): { from: number; to: number } {
	const word = find(session, "linked")

	expect(session.dispatch(session.state.tr.addMark(word.at, word.at + 6, link("https://a.example/")))).toBe(true)

	const from = find(session, "Open").node
	const to = session.state.doc.resolve(from).end()

	expect(session.state.tr.addMark(from, to, link("https://b.example/")).steps.map(step => step.constructor)).toEqual([AddMarkStep])

	return { from, to }
}

describe("MarkSetStep", () => {
	it("reads one as the mark steps it holds, nested sets flattened", async () => {
		const { session } = await open({ body: p("Plain linked text") })
		const word = find(session, "linked")
		const withA = session.state.tr.addMark(word.at, word.at + 6, link("https://a.example/")).doc
		const from = word.node
		const to = word.end
		const add = new AddMarkStep(from, to, link("https://b.example/"))
		const inverse = add.invert(withA)

		expect(stepType(inverse)).toBe("markSet")
		expect(inverse).not.toBeInstanceOf(AddMarkStep)
		expect(inverse).not.toBeInstanceOf(RemoveMarkStep)

		const parts = markStepsOf(inverse) ?? []
		const shape = (step: Step): unknown =>
			step instanceof AddMarkStep || step instanceof RemoveMarkStep
				? { kind: step.constructor, range: [step.from, step.to], target: step.mark.attrs["target"] }
				: step

		// B off the text up to the end of A's word, A back on the word, B off the rest.
		expect(parts.map(shape)).toEqual([
			{ kind: RemoveMarkStep, range: [from, word.at + 6], target: "https://b.example/" },
			{ kind: AddMarkStep, range: [word.at, word.at + 6], target: "https://a.example/" },
			{ kind: RemoveMarkStep, range: [word.at + 6, to], target: "https://b.example/" }
		])
		expect(parts.flatMap(markStepTypes)).toEqual([marks.link, marks.link, marks.link])
		expect(parts.flatMap(markStepPieces).map(piece => [piece.from, piece.to])).toEqual([
			[from, word.at + 6],
			[word.at, word.at + 6],
			[word.at + 6, to]
		])

		// The redo of that undo: a set holding a set (A's AddMarkStep displaces B again).
		const withB = add.apply(withA).doc

		if (withB === null) throw new Error("not applied")

		const redo = inverse.invert(withB)

		expect((redo.toJSON() as { steps: { stepType: string }[] }).steps.map(step => step.stepType)).toContain("markSet")
		expect((markStepsOf(redo) ?? []).map(shape)).toEqual([
			{ kind: AddMarkStep, range: [from, word.at + 6], target: "https://b.example/" },
			{ kind: RemoveMarkStep, range: [word.at, word.at + 6], target: "https://a.example/" },
			{ kind: AddMarkStep, range: [word.at, word.at + 6], target: "https://b.example/" },
			{ kind: AddMarkStep, range: [word.at + 6, to], target: "https://b.example/" }
		])

		// A plain mark step stands for itself; any other step for none.
		expect(markStepsOf(add)).toEqual([add])
		expect(markStepsOf(new ReplaceStep(from, from, Slice.empty))).toBeUndefined()
	})

	it("is checked by protection over its ranges: allowed in an open range, refused outside", async () => {
		const { session } = await open(PROTECTED)
		const { from, to } = linkWord(session)
		const withA = session.state.doc

		expect(session.dispatch(session.state.tr.addMark(from, to, link("https://b.example/")))).toBe(true)

		const inside = session.state.tr.step(new AddMarkStep(from, to, link("https://b.example/")).invert(withA))

		expect(session.dispatch(inside)).toBe(true)
		expect(refusedForForms(inside)).toBeUndefined()
		expect(session.state.doc.eq(withA)).toBe(true)

		// The same change over the fixed paragraph is outside every open range.
		const fixed = find(session, "Fixed text")
		const fixedA = session.state.tr.addMark(fixed.at, fixed.at + 5, link("https://a.example/")).doc
		const outside = session.state.tr.step(new AddMarkStep(fixed.node, fixed.end, link("https://b.example/")).invert(fixedA))

		expect(stepType(outside.steps[0] as Step)).toBe("markSet")
		expect(session.dispatch(outside)).toBe(false)
		expect(refusedForForms(outside)).toBe("protected")
	})

	it("records the formatting it changes as a tracked change", async () => {
		const { context, session } = await open({ body: p("Plain colored text") })
		const word = find(session, "colored")

		expect(session.dispatch(session.state.tr.addMark(word.at, word.at + 7, marks.color.create({ value: "FF0000" })))).toBe(true)

		const withRed = session.state.doc
		const from = find(session, "Plain").node
		const to = session.state.doc.resolve(from).end()
		const blue = marks.color.create({ value: "0000FF" })

		expect(session.dispatch(session.state.tr.addMark(from, to, blue))).toBe(true)

		context.review.tracking = true

		const inverse = new AddMarkStep(from, to, blue).invert(withRed)

		expect(stepType(inverse)).toBe("markSet")
		expect(session.dispatch(session.state.tr.step(inverse))).toBe(true)

		let changed = ""

		session.state.doc.descendants(node => {
			if (node.isText && marks.format_change.isInSet(node.marks) !== undefined) changed += node.text ?? ""
		})

		expect(changed).toBe("Plain colored text")
	})

	for (const tracking of [false, true])
		it(`undoes and redoes a link displacing another in forms protection${tracking ? ", tracked" : ""}`, async () => {
			const { context, session } = await open(PROTECTED)

			context.review.tracking = tracking

			const { from, to } = linkWord(session)
			const withA = session.state.doc

			session.dispatch(session.state.tr.setSelection(TextSelection.create(withA, from, to)))

			expect(session.dispatch(session.state.tr.addMark(from, to, link("https://b.example/")))).toBe(true)

			const withB = session.state.doc
			const applied: Transaction[] = []

			session.onApplied(transactions => applied.push(...transactions))

			expect(session.execute({ type: "history.undo" })).toBe(true)
			expect(applied.flatMap(tr => tr.steps).map(stepType)).toContain("markSet")
			expect(session.state.doc.eq(withA)).toBe(true)
			expect(session.execute({ type: "history.redo" })).toBe(true)
			expect(session.state.doc.eq(withB)).toBe(true)
		})
})
