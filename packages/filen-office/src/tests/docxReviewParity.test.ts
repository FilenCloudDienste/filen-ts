import type { Node } from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import { ReplaceStep, type Step } from "prosemirror-transform"
import { describe, expect, it } from "vitest"
import { DocxEditorSession, docxSchema } from "@filen/office/core/docx/edit"
import { RESOLVE_BULK, resolveChanges, storyReviewIndex } from "../core/docx/review/accept"
import { MARK_BULK } from "../core/docx/review/track"
import { openSpec } from "./docxEditFixtures"
import { p, type SyntheticDocx } from "./docxSynthetic"

// Resolving tracked changes and recording them each have two ways to apply a plan: a step per operation and,
// past a threshold, one rebuild of the blocks touched. A scenario gives the same blocks either way.

const marks = docxSchema.marks
const STAMP = 'w:author="Bob" w:date="2026-01-01T00:00:00Z"'
const NOW = Date.UTC(2026, 9, 12, 13, 25, 41)
const SECT =
	'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
const run = (text: string, rPr = ""): string =>
	`<w:r>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`
const pr = (content: string, pPr = ""): string => `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}${content}</w:p>`
const ins = (id: number, text: string): string => `<w:ins w:id="${String(id)}" ${STAMP}>${run(text)}</w:ins>`
const del = (id: number, text: string): string =>
	`<w:del w:id="${String(id)}" ${STAMP}><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`
const markIns = (id: number): string => `<w:rPr><w:ins w:id="${String(id)}" ${STAMP}/></w:rPr>`
const markDel = (id: number): string => `<w:rPr><w:del w:id="${String(id)}" ${STAMP}/></w:rPr>`
const tc = (text: string, tcPr = ""): string => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${tcPr}</w:tcPr>${p(text)}</w:tc>`
const row = (cells: string, trPr = ""): string => `<w:tr>${trPr === "" ? "" : `<w:trPr>${trPr}</w:trPr>`}${cells}</w:tr>`
const table = (rows: string): string =>
	`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows}</w:tbl>`

async function sessionOf(spec: SyntheticDocx, tracking: boolean): Promise<DocxEditorSession> {
	const opened = await openSpec(spec)

	opened.context.identity.author = "Ann"
	opened.context.identity.now = () => NOW
	opened.context.review.tracking = tracking

	return new DocxEditorSession(opened.context)
}

function blocks(doc: Node, from: number, to: number): unknown[] {
	const out: unknown[] = []

	for (let k = from; k < to; k++) out.push(doc.child(k).toJSON())

	return out
}

function size(doc: Node, from: number, to: number): number {
	let total = 0

	for (let k = from; k < to; k++) total += doc.child(k).nodeSize

	return total
}

// A step that replaced at least `span` of the document at once: the bulk path's rebuild (the step path only
// replaces what one operation covers).
function rebuilt(steps: readonly Step[], span: number): boolean {
	return steps.some(step => step instanceof ReplaceStep && step.to - step.from >= span)
}

// ---- resolving ------------------------------------------------------------------------------------------------

interface Resolution {
	readonly name: string
	readonly body: string
	readonly comments?: string
	// Changes the planner cannot resolve, by direction (none when not given): what is not skipped must change
	// the scenario's blocks, so a scenario cannot pass vacuously.
	readonly skipped?: { readonly accept?: number; readonly reject?: number }
}

const BOOKMARK = '<w:bookmarkStart w:id="40" w:name="mark"/>'
const BOOKMARK_END = '<w:bookmarkEnd w:id="40"/>'

const RESOLUTIONS: readonly Resolution[] = [
	{ name: "an insertion", body: pr(`${run("Kept ")}${ins(10, "inserted")}${run(" end")}`) },
	{ name: "a deletion", body: pr(`${run("Kept ")}${del(10, "deleted")}${run(" end")}`) },
	{
		name: "a run format change",
		body: pr(`${run("Plain ")}${run("bold", `<w:b/><w:rPrChange w:id="10" ${STAMP}><w:rPr/></w:rPrChange>`)}`)
	},
	{
		name: "a paragraph format change",
		body: pr(run("Centred"), `<w:jc w:val="center"/><w:pPrChange w:id="10" ${STAMP}><w:pPr><w:jc w:val="right"/></w:pPr></w:pPrChange>`)
	},
	{ name: "an inserted paragraph mark (joined when rejected)", body: pr(run("First"), markIns(10)) + p("Second") },
	{ name: "a deleted paragraph mark (joined when accepted)", body: pr(run("First"), markDel(10)) + p("Second") },
	{
		// Not emptied, the paragraph cannot join a table: the planner skips the change before either path.
		name: "a deleted paragraph mark before a table (blocked when accepted)",
		body: pr(run("Before"), markDel(10)) + table(row(tc("a1") + tc("b1"))) + p("After"),
		skipped: { accept: 1 }
	},
	{
		// Emptied, the paragraph goes, its markers to the table.
		name: "a deleted paragraph mark before a table, the paragraph emptied (joined when accepted)",
		body: `${p("Lead")}${BOOKMARK}${pr(del(11, "gone"), markDel(10))}${table(row(tc("a1") + tc("b1")))}${pr(run("After") + BOOKMARK_END)}`
	},
	{
		name: "an inserted paragraph mark before a table, the paragraph emptied (joined when rejected)",
		body: `${p("Lead")}${BOOKMARK}${pr(ins(11, "new"), markIns(10))}${table(row(tc("a1") + tc("b1")))}${pr(run("After") + BOOKMARK_END)}`
	},
	{
		// The table goes whole: the paragraph joins the one after it.
		name: "a deleted paragraph mark before a deleted table (joined when accepted)",
		body: p("Lead") + pr(run("First"), markDel(10)) + table(row(tc("a1") + tc("b1"), `<w:del w:id="12" ${STAMP}/>`)) + p("After")
	},
	{ name: "a deleted section break mark", body: p("One") + pr(run("Two"), markDel(10) + SECT) + p("Three") },
	{
		name: "an inserted row",
		body: p("Before") + table(row(tc("a1") + tc("b1")) + row(tc("a2") + tc("b2"), `<w:ins w:id="10" ${STAMP}/>`)) + p("After")
	},
	{
		name: "a deleted row",
		body: p("Before") + table(row(tc("a1") + tc("b1")) + row(tc("a2") + tc("b2"), `<w:del w:id="10" ${STAMP}/>`)) + p("After")
	},
	{
		name: "an inserted cell",
		body: p("Before") + table(row(tc("a1") + tc("b1", `<w:cellIns w:id="10" ${STAMP}/>`)) + row(tc("a2") + tc("b2"))) + p("After")
	},
	{
		name: "a deleted cell",
		body: p("Before") + table(row(tc("a1") + tc("b1", `<w:cellDel w:id="10" ${STAMP}/>`)) + row(tc("a2") + tc("b2"))) + p("After")
	},
	{
		name: "a move",
		body:
			pr(
				`<w:moveFromRangeStart w:id="10" w:name="move1" ${STAMP}/><w:moveFrom w:id="11" ${STAMP}>${run("Moved. ")}</w:moveFrom>` +
					`<w:moveFromRangeEnd w:id="10"/>${run("Stays.")}`
			) +
			pr(
				`<w:moveToRangeStart w:id="12" w:name="move1" ${STAMP}/><w:moveTo w:id="13" ${STAMP}>${run("Moved. ")}</w:moveTo>` +
					`<w:moveToRangeEnd w:id="12"/>${run("Target.")}`
			)
	},
	{
		name: "a comment on deleted text",
		body: pr(
			`${run("Alpha ")}<w:del w:id="10" ${STAMP}><w:commentRangeStart w:id="0"/><w:r><w:delText>beta</w:delText></w:r><w:commentRangeEnd w:id="0"/>` +
				`<w:r><w:commentReference w:id="0"/></w:r></w:del>${run(" gamma")}`
		),
		comments: `<w:comment w:id="0" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:p>${run("Note")}</w:p></w:comment>`
	}
]

// Independent deletions after the scenario's blocks (blocks keep the indices of the source elements they were
// read from), one per paragraph, enough for the plan to pass the threshold either way (each is a
// deletion to apply when accepted, a mark to remove when rejected).
const RESOLVE_PADDING = RESOLVE_BULK + 1
const resolvePadding = Array.from({ length: RESOLVE_PADDING }, (_, k) => pr(`${run(`Pad ${String(k)} `)}${del(9000 + k, "x")}`)).join("")

async function resolved(
	scenario: Resolution,
	padded: boolean,
	accept: boolean
): Promise<{ opened: Node; doc: Node; skipped: number; bulk: boolean }> {
	const spec: SyntheticDocx = {
		body: scenario.body + (padded ? resolvePadding : ""),
		...(scenario.comments === undefined ? {} : { comments: scenario.comments })
	}
	const session = await sessionOf(spec, false)
	const doc = session.state.doc
	const span = padded ? size(doc, doc.childCount - RESOLVE_PADDING, doc.childCount) : Infinity
	const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, accept)

	// (Nothing may change: a change that cannot be resolved is skipped.)
	if (outcome.tr !== null) expect(session.dispatch(outcome.tr)).toBe(true)

	return { opened: doc, doc: session.state.doc, skipped: outcome.skipped, bulk: outcome.tr !== null && rebuilt(outcome.tr.steps, span) }
}

describe("docx review parity: resolving", () => {
	for (const scenario of RESOLUTIONS)
		for (const accept of [true, false])
			it(`${accept ? "accepts" : "rejects"} ${scenario.name} the same with one rebuild as step by step`, async () => {
				const alone = await resolved(scenario, false, accept)
				const padded = await resolved(scenario, true, accept)

				const count = padded.doc.childCount - RESOLVE_PADDING
				const skipped = (accept ? scenario.skipped?.accept : scenario.skipped?.reject) ?? 0

				expect(alone.skipped).toBe(skipped)

				if (skipped === 0)
					expect(blocks(alone.doc, 0, alone.doc.childCount)).not.toEqual(blocks(alone.opened, 0, alone.opened.childCount))

				expect(padded.bulk).toBe(true)
				expect(padded.skipped).toBe(alone.skipped)
				expect(count).toBe(alone.doc.childCount)
				expect(blocks(padded.doc, 0, count)).toEqual(blocks(alone.doc, 0, alone.doc.childCount))
			})
})

// ---- recording ------------------------------------------------------------------------------------------------

interface Recording {
	readonly name: string
	readonly body: string
	// Edits the scenario's blocks (positions in the document as opened).
	edit(tr: Transaction, find: (text: string) => number): void
}

const RECORDINGS: readonly Recording[] = [
	{ name: "typing", body: p("one two"), edit: (tr, find) => void tr.insertText(" new", find("two") + 3) },
	{ name: "a deletion in a paragraph", body: p("one two three"), edit: (tr, find) => void tr.delete(find("two"), find("two") + 4) },
	{
		name: "a deletion over a paragraph mark",
		body: p("one two") + p("three four"),
		edit: (tr, find) => void tr.delete(find("two"), find("three") + 5)
	},
	{
		name: "a deletion over a section break",
		body: p("one") + pr(run("two"), SECT) + p("three"),
		edit: (tr, find) => void tr.delete(find("one") + 1, find("three") + 2)
	},
	{
		name: "a deletion over a table",
		body: p("before") + table(row(tc("a1") + tc("b1")) + row(tc("a2") + tc("b2"))) + p("after"),
		edit: (tr, find) => void tr.delete(find("before") + 3, find("after") + 2)
	},
	{ name: "a paragraph split", body: p("one two"), edit: (tr, find) => void tr.split(find("two")) },
	{
		name: "formatting",
		body: p("one two three"),
		edit: (tr, find) => void tr.addMark(find("two"), find("two") + 3, marks.italic.create())
	},
	{
		name: "a paragraph property",
		body: p("one") + p("two"),
		edit: (tr, find) => void tr.setNodeAttribute(find("two") - 1, "align", "center")
	}
]

// A property change of each of the independent paragraphs after the scenario's (as above): recorded after the
// scenario's changes, so the ids the scenario's take do not depend on the padding.
const MARK_PADDING = MARK_BULK + 1
const markPadding = Array.from({ length: MARK_PADDING }, (_, k) => p(`Pad ${String(k)}`)).join("")

async function recorded(scenario: Recording, padded: boolean): Promise<{ doc: Node; bulk: boolean }> {
	const session = await sessionOf({ body: scenario.body + (padded ? markPadding : "") }, true)
	const doc = session.state.doc
	const first = doc.childCount - (padded ? MARK_PADDING : 0)
	const find = (text: string): number => {
		let found = -1

		doc.descendants((node, pos) => {
			if (found < 0 && node.isText && (node.text ?? "").includes(text)) found = pos + (node.text ?? "").indexOf(text)

			return found < 0
		})

		expect(found).toBeGreaterThan(0)

		return found
	}
	const tr = session.state.tr

	scenario.edit(tr, find)

	if (padded) {
		let pos = size(doc, 0, first)

		for (let k = first; k < doc.childCount; k++) {
			tr.setNodeAttribute(tr.mapping.map(pos), "align", "right")
			pos += doc.child(k).nodeSize
		}
	}

	const steps: Step[] = []
	const stop = session.onApplied(transactions => {
		for (const applied of transactions) steps.push(...applied.steps)
	})

	expect(session.dispatch(tr)).toBe(true)
	stop()

	return { doc: session.state.doc, bulk: rebuilt(steps, padded ? size(doc, first, doc.childCount) : Infinity) }
}

describe("docx review parity: recording", () => {
	for (const scenario of RECORDINGS)
		it(`marks ${scenario.name} the same with one rebuild as step by step`, async () => {
			const alone = await recorded(scenario, false)
			const padded = await recorded(scenario, true)
			const count = padded.doc.childCount - MARK_PADDING

			expect(padded.bulk).toBe(true)
			expect(count).toBe(alone.doc.childCount)
			expect(blocks(padded.doc, 0, count)).toEqual(blocks(alone.doc, 0, alone.doc.childCount))
		})
})
