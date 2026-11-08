import { unzipSync } from "fflate"
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { DocxEditorSession, docxSchema } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { resolveChanges, storyReviewIndex } from "../core/docx/review/accept"
import { minuteDate } from "../core/docx/review/track"
import { openBytes, openSpec, type Opened } from "./docxEditFixtures"
import { p, type SyntheticDocx } from "./docxSynthetic"

// Tracked moves (Word's Track moves): dragged text, and text cut and then pasted, is recorded as a move.

const marks = docxSchema.marks
const NOW = Date.UTC(2026, 9, 12, 13, 25, 41)
const DATE = minuteDate(NOW)

interface Tracked extends Opened {
	readonly session: DocxEditorSession
}

async function tracked(spec: SyntheticDocx): Promise<Tracked> {
	const opened = await openSpec(spec)

	opened.context.identity.author = "Ann"
	opened.context.identity.now = () => NOW
	opened.context.review.tracking = true

	return { ...opened, session: new DocxEditorSession(opened.context) }
}

// Text with its revision marks: {<moved from<}, {>moved to>}, [-deleted-], [+inserted+], markers as |kind|.
function shown(doc: Node): string[] {
	const out: string[] = []

	doc.descendants(node => {
		if (node.type !== docxSchema.nodes.paragraph) return true

		let text = ""

		node.forEach(child => {
			if (child.type === docxSchema.nodes.marker) {
				text += `|${String(child.attrs["kind"])}|`

				return
			}

			const value = child.text ?? `<${child.type.name}>`

			text += marks.move_from.isInSet(child.marks)
				? `{<${value}<}`
				: marks.move_to.isInSet(child.marks)
					? `{>${value}>}`
					: marks.deletion.isInSet(child.marks)
						? `[-${value}-]`
						: marks.insertion.isInSet(child.marks)
							? `[+${value}+]`
							: value
		})
		out.push(
			text
				.replace(/<\}\{</g, "")
				.replace(/>\}\{>/g, "")
				.replace(/-\]\[-/g, "")
				.replace(/\+\]\[\+/g, "")
		)

		return false
	})

	return out
}

// Where `text` starts in the session's document.
function find(session: DocxEditorSession, text: string): number {
	let at = -1

	session.state.doc.descendants((node, pos) => {
		if (at < 0 && node.isText) {
			const index = (node.text ?? "").indexOf(text)

			if (index >= 0) at = pos + index
		}

		return at < 0
	})

	if (at < 0) throw new Error(`no ${text}`)

	return at
}

// A drag of [from, to) dropped at `at` (a position of the document before the drag), as the view makes it.
function drag(session: DocxEditorSession, from: number, to: number, at: number): boolean {
	const state = session.state
	const slice = state.doc.slice(from, to)
	const tr = state.tr.setSelection(TextSelection.create(state.doc, from, to)).deleteSelection()
	const pos = tr.mapping.map(at)

	return session.dispatch(tr.replaceRange(pos, pos, slice).setMeta("uiEvent", "drop"))
}

// Cuts [from, to) and returns what the clipboard holds.
function cut(session: DocxEditorSession, from: number, to: number) {
	const slice = session.state.doc.slice(from, to)
	const state = session.state

	expect(
		session.dispatch(
			state.tr
				.setSelection(TextSelection.create(state.doc, from, to))
				.deleteSelection()
				.setMeta("uiEvent", "cut")
		)
	).toBe(true)

	return slice
}

function paste(session: DocxEditorSession, at: number, slice: ReturnType<typeof cut>): boolean {
	const state = session.state
	const tr = state.tr.setSelection(TextSelection.create(state.doc, at)).replaceSelection(slice)

	return session.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste"))
}

async function save(opened: Opened, session: DocxEditorSession): Promise<{ bytes: Uint8Array; xml: string }> {
	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

	if (result.bytes === undefined) throw new Error("no bytes")

	return { bytes: result.bytes, xml: new TextDecoder().decode(unzipSync(result.bytes)["word/document.xml"]) }
}

function moveCount(doc: Node): number {
	let count = 0

	doc.descendants(node => {
		if (marks.move_from.isInSet(node.marks) !== undefined || marks.move_to.isInSet(node.marks) !== undefined) count++
		if (node.type === docxSchema.nodes.marker && String(node.attrs["kind"]).startsWith("move")) count++

		return true
	})

	return count
}

const FROM_RANGE = "|moveFromRangeStart|{<Moved. <}|moveFromRangeEnd|"
const TO_RANGE = "|moveToRangeStart|{>Moved. >}|moveToRangeEnd|"

describe("docx tracked moves", () => {
	it("records a drag as a move, writes it as Word does and reads it back", async () => {
		const doc = await tracked({ body: p("Moved. Stays.") + p("Target.") })
		const session = doc.session
		const from = find(session, "Moved. ")

		expect(drag(session, from, from + 7, find(session, "Target."))).toBe(true)
		expect(shown(session.state.doc)).toEqual([`${FROM_RANGE}Stays.`, `${TO_RANGE}Target.`])

		const { xml, bytes } = await save(doc, session)

		expect(xml).toMatch(
			new RegExp(
				`<w:moveFromRangeStart w:id="(\\d+)" w:name="(move\\d+)" w:author="Ann" w:date="${DATE}"/>` +
					`<w:moveFrom w:id="\\d+" w:author="Ann" w:date="${DATE}"><w:r><w:t xml:space="preserve">Moved. </w:t></w:r></w:moveFrom>` +
					'<w:moveFromRangeEnd w:id="\\1"/>'
			)
		)
		expect(xml).toMatch(
			new RegExp(
				`<w:moveToRangeStart w:id="(\\d+)" w:name="(move\\d+)" w:author="Ann" w:date="${DATE}"/>` +
					`<w:moveTo w:id="\\d+" w:author="Ann" w:date="${DATE}"><w:r><w:t xml:space="preserve">Moved. </w:t></w:r></w:moveTo>` +
					'<w:moveToRangeEnd w:id="\\1"/>'
			)
		)

		const names = [...xml.matchAll(/RangeStart w:id="\d+" w:name="([^"]+)"/g)].map(match => match[1])

		expect(names).toHaveLength(2)
		expect(names[0]).toBe(names[1])

		const reopened = new DocxEditorSession((await openBytes(bytes)).context)

		expect(shown(reopened.state.doc)).toEqual([`${FROM_RANGE}Stays.`, `${TO_RANGE}Target.`])
	})

	it("records a cut and the paste after it as one move, in the paste's undo step", async () => {
		const doc = await tracked({ body: p("Moved. Stays.") + p("Target.") })
		const session = doc.session
		const from = find(session, "Moved. ")
		const slice = cut(session, from, from + 7)

		expect(shown(session.state.doc)).toEqual(["[-Moved. -]Stays.", "Target."])
		expect(paste(session, find(session, "Target."), slice)).toBe(true)
		expect(shown(session.state.doc)).toEqual([`${FROM_RANGE}Stays.`, `${TO_RANGE}Target.`])
		await expect(save(doc, session)).resolves.toBeDefined()

		// Undo takes the paste back: the cut is a deletion again.
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(shown(session.state.doc)).toEqual(["[-Moved. -]Stays.", "Target."])
	})

	it("accepts and rejects a recorded move as a pair", async () => {
		for (const accept of [true, false]) {
			const doc = await tracked({ body: p("Moved. Stays.") + p("Target.") })
			const session = doc.session
			const from = find(session, "Moved. ")

			drag(session, from, from + 7, find(session, "Target."))

			// Resolving at the destination resolves the source too.
			const at = find(session, "Target.") - 2
			const outcome = resolveChanges(session, storyReviewIndex(session), { from: at, to: at }, accept)

			expect(session.dispatch(outcome.tr as never)).toBe(true)
			expect(moveCount(session.state.doc)).toBe(0)
			expect(shown(session.state.doc)).toEqual(accept ? ["Stays.", "Moved. Target."] : ["Moved. Stays.", "Target."])
			await expect(save(doc, session)).resolves.toBeDefined()
		}
	})

	it("records a deletion and an insertion where the document asks for moves not to be tracked", async () => {
		const doc = await tracked({ body: p("Moved. Stays.") + p("Target."), settings: "<w:doNotTrackMoves/>" })
		const session = doc.session
		const from = find(session, "Moved. ")

		drag(session, from, from + 7, find(session, "Target."))
		expect(shown(session.state.doc)).toEqual(["[-Moved. -]Stays.", "[+Moved. +]Target."])

		const slice = cut(session, find(session, "Stays."), find(session, "Stays.") + 6)

		paste(session, find(session, "Target."), slice)
		expect(moveCount(session.state.doc)).toBe(0)
	})

	it("keeps a copy and paste and a paste after another edit an insertion", async () => {
		const doc = await tracked({ body: p("Moved. Stays.") + p("Target.") })
		const session = doc.session

		// A copy: nothing was cut.
		const from = find(session, "Moved. ")

		paste(session, find(session, "Target."), session.state.doc.slice(from, from + 7))
		expect(shown(session.state.doc)).toEqual(["Moved. Stays.", "[+Moved. +]Target."])

		// Something typed between the cut and the paste.
		const slice = cut(session, find(session, "Stays."), find(session, "Stays.") + 6)

		session.dispatch(session.state.tr.insertText("x", find(session, "Target.")))
		paste(session, find(session, "Target."), slice)
		expect(moveCount(session.state.doc)).toBe(0)
		expect(shown(session.state.doc)).toEqual(["Moved. [-Stays.-]", "[+Moved. xStays.+]Target."])
	})

	it("drags text an insertion is recorded on as a deletion and an insertion", async () => {
		const doc = await tracked({ body: p("One two.") + p("Target.") })
		const session = doc.session

		session.dispatch(session.state.tr.delete(find(session, "two"), find(session, "two") + 3))

		const from = find(session, "One")

		// The dragged range takes the deleted word with it.
		drag(session, from, find(session, "."), find(session, "Target."))
		expect(moveCount(session.state.doc)).toBe(0)
	})
})
