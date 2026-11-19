import type { Node } from "prosemirror-model"
import { describe, expect, it } from "vitest"
import { TextSelection } from "prosemirror-state"
import {
	blockPositions,
	findUnsavableBlocks,
	revertFeatureUnits,
	withRevertedUnits,
	type DocxEditorSession
} from "@filen/office/core/docx/edit"
import { nodeText, sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const BODY =
	p("Zero") +
	p("One") +
	'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>' +
	`<w:tr>${cell("Cell")}</w:tr></w:tbl>` +
	p("Three") +
	p("Four")

// Appends `text` to the end of every top-level or cell paragraph whose text is one of `names`.
function edit(session: DocxEditorSession, names: readonly string[], text: string): void {
	const ends: number[] = []

	session.state.doc.descendants((node, pos) => {
		if (node.isTextblock && names.includes(nodeText(node))) ends.push(pos + 1 + node.content.size)

		return !node.isTextblock
	})

	for (const end of ends.reverse()) session.dispatch(session.state.tr.insertText(text, end))
}

function texts(doc: Node): string[] {
	const out: string[] = []

	doc.descendants(node => {
		if (node.isTextblock) out.push(nodeText(node))
		if (node.type.name === "locked_block") out.push(`locked:${String(node.attrs["text"])}`)

		return !node.isTextblock && node.type.name !== "locked_block"
	})

	return out
}

// A writer that refuses any document still holding the text `bad`.
function refusing(bad: string): { writes: (sessions: readonly DocxEditorSession[]) => Promise<boolean>; runs: () => number } {
	let runs = 0

	return {
		writes: sessions => {
			runs++

			return Promise.resolve(
				!sessions.some(session => texts(session.state.doc).some(text => !text.startsWith("locked:") && text.includes(bad)))
			)
		},
		runs: () => runs
	}
}

describe("edited blocks at save time", () => {
	it("lists the source blocks changed since the save, cell paragraphs included", async () => {
		const session = await sessionOf({ body: BODY })

		expect(session.editedBlocks()).toEqual([])
		edit(session, ["One", "Cell", "Four"], "!")

		const doc = session.state.doc

		expect(session.editedBlocks().map(pos => nodeText(doc.nodeAt(pos) as Node))).toEqual(["One!", "Cell!", "Four!"])
		session.markSaved()
		expect(session.editedBlocks()).toEqual([])
	})

	it("tries on a stand-in, then takes back for real as one undoable step, keeping the other edits", async () => {
		const session = await sessionOf({ body: BODY })

		edit(session, ["One", "Three"], "!")

		const [one, three] = session.editedBlocks()

		if (one === undefined || three === undefined) throw new Error("no edited blocks")

		const trial = session.withReverted([one])

		// Never saved since it opened: back to the file's own, locked.
		expect(texts(trial.state.doc)).toEqual(["Zero", "locked:One", "Cell", "Three!", "Four"])
		expect(texts(session.state.doc)).toEqual(["Zero", "One!", "Cell", "Three!", "Four"])

		const block = session.state.doc.nodeAt(one)

		if (block === null) throw new Error("no block")

		expect(session.revert([block])).toBe(1)
		expect(texts(session.state.doc)).toEqual(["Zero", "locked:One", "Cell", "Three!", "Four"])
		// The edit comes back with an undo.
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(texts(session.state.doc)).toEqual(["Zero", "One!", "Cell", "Three!", "Four"])
		// A block changed since the trial is left as it is.
		edit(session, ["One!"], "?")
		expect(session.revert([block])).toBe(0)
		expect(texts(session.state.doc)[1]).toBe("One!?")
	})

	it("takes a block back to how it was last saved, not to how the file opened", async () => {
		const session = await sessionOf({ body: BODY })

		edit(session, ["One"], " saved")
		session.markSaved()
		edit(session, ["One saved"], " BAD")

		const [one] = session.editedBlocks()

		if (one === undefined) throw new Error("no edited block")

		expect(texts(session.withReverted([one]).state.doc)).toEqual(["Zero", "One saved", "Cell", "Three", "Four"])

		const block = session.state.doc.nodeAt(one)

		if (block === null) throw new Error("no block")

		session.revert([block])
		expect(texts(session.state.doc)).toEqual(["Zero", "One saved", "Cell", "Three", "Four"])
		expect(session.snapshot().dirty).toBe(false)
	})

	it("finds the blocks the writer refuses and only those", async () => {
		const session = await sessionOf({ body: BODY })

		edit(session, ["Zero", "One", "Cell", "Three", "Four"], " edited")
		edit(session, ["Cell edited", "Four edited"], " BAD")

		const writer = refusing("BAD")
		const found = await findUnsavableBlocks([session], writer.writes)

		expect(found).not.toBeNull()

		const doc = session.state.doc

		expect(found?.flatMap(entry => blockPositions(entry.units).map(pos => nodeText(doc.nodeAt(pos) as Node)))).toEqual([
			"Cell edited BAD",
			"Four edited BAD"
		])
		expect(writer.runs()).toBeLessThanOrEqual(12)

		for (const entry of found ?? []) {
			const doc = entry.session.state.doc

			entry.session.revert(blockPositions(entry.units).map(pos => doc.nodeAt(pos) as Node))
		}

		expect(texts(session.state.doc)).toEqual(["Zero edited", "One edited", "locked:Cell", "Three edited", "locked:Four"])
		expect(await writer.writes([session])).toBe(true)
	})

	it("gives up when locking edited blocks cannot help or nothing was edited", async () => {
		const session = await sessionOf({ body: BODY })

		expect(await findUnsavableBlocks([session], () => Promise.resolve(false))).toBeNull()
		edit(session, ["One"], "!")
		// Refused whatever is locked: not about an edited block.
		expect(await findUnsavableBlocks([session], () => Promise.resolve(false))).toBeNull()
		// Accepted with nothing locked: the refusal was elsewhere (the zip).
		expect(await findUnsavableBlocks([session], () => Promise.resolve(true))).toBeNull()

		edit(session, ["Zero", "Three", "Four"], " BAD")
		expect(await findUnsavableBlocks([session], refusing("BAD").writes, { maxAttempts: 3 })).toBeNull()

		// Out of time: stops between runs, giving the page its turn before each.
		let clock = 0
		const pauses: number[] = []
		const slow = refusing("BAD")

		expect(
			await findUnsavableBlocks(
				[session],
				async sessions => {
					clock += 1000

					return slow.writes(sessions)
				},
				{ budgetMs: 2500, now: () => clock, pause: () => Promise.resolve(void pauses.push(clock)) }
			)
		).toBeNull()
		expect(slow.runs()).toBe(3)
		expect(pauses).toEqual([1000, 2000])
	})

	it("does not try again what is known to be refused", async () => {
		const session = await sessionOf({ body: BODY })

		edit(session, ["One", "Four"], " BAD")

		const writer = refusing("BAD")
		const known = refusing("BAD")

		await findUnsavableBlocks([session], writer.writes)
		await findUnsavableBlocks([session], known.writes, { refused: true })
		expect(known.runs()).toBe(writer.runs() - 1)
	})
	it("finds a table the editor made as the unit to take back, which the stand-in and the revert both take", async () => {
		const session = await sessionOf({ body: BODY })
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.isTextblock && nodeText(node) === "Four") at = pos + 1
		})
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, at)))
		expect(session.execute({ type: "table.insert", rows: 1, cols: 1 })).toBe(true)

		// The writer refuses any document with a second table.
		const writes = (sessions: readonly DocxEditorSession[]): Promise<boolean> => {
			let tables = 0

			sessions[0]?.state.doc.descendants(node => {
				if (node.type.name === "table") tables++

				return !node.isTextblock
			})

			return Promise.resolve(tables < 2)
		}
		const found = await findUnsavableBlocks([session], writes)

		expect(found?.map(entry => entry.units)).toEqual([[{ kind: "table", key: -1 }]])

		const entry = found?.[0]

		if (entry === undefined) throw new Error("nothing found")

		expect(await writes([withRevertedUnits(entry.session, entry.units)])).toBe(true)
		expect(await writes([session])).toBe(false)
		expect(revertFeatureUnits(session, entry.units)).toBe(1)
		expect(await writes([session])).toBe(true)
	})
})
