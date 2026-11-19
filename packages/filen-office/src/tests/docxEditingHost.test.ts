import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { DocxEditorSession, docxSchema, type BlockProof } from "@filen/office/core/docx/edit"
import { prepareDocxSave, saveDocx, writerProof } from "@filen/office/core/docx/write"
import type { DocxEngineServices } from "@filen/office/dom/docx"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"
import { nodeText, openBytes } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { engineServices } from "./engineFixtures"

function services(pauses: { count: number }): DocxEngineServices {
	return engineServices({
		yield: () => {
			pauses.count++

			return Promise.resolve()
		},
		// Every slice pauses: the proof runs in its smallest steps.
		sliceMs: 0
	})
}

// Locks every paragraph whose text says so.
const LOCK_MARKED: BlockProof = {
	check: node => (node.type === docxSchema.nodes.paragraph && node.textContent.includes("LOCK") ? "proof" : undefined)
}

const BODY = Array.from({ length: 90 }, (_, k) => p(k % 30 === 7 ? `Paragraph ${k} LOCK` : `Paragraph ${k}`)).join("")

describe("inThreadEditingHost", () => {
	it("proves the body in slices, locks only the failing blocks and opens clean", async () => {
		const pauses = { count: 0 }
		const editing = inThreadEditingHost(() => services(pauses), { proof: () => LOCK_MARKED })
		const session = editing.host(bytesSource(buildDocx({ body: BODY })), () => undefined)

		expect(editing.saveInput()).toBeUndefined()

		const editor = await editing.editor
		let locked = 0

		editor.state.doc.forEach(node => {
			if (node.type === docxSchema.nodes.locked_block) locked++
		})

		expect(editing.proofLocked()).toBe(3)
		expect(locked).toBe(3)
		expect(editor.session.snapshot().dirty).toBe(false)
		expect(pauses.count).toBeGreaterThan(3)
		session.close()
		expect(editing.saveInput()).toBeUndefined()
	})

	it("saves every story's edits through the writer with the real proof", async () => {
		const editing = inThreadEditingHost(() => services({ count: 0 }), { proof: writerProof })
		const session = editing.host(bytesSource(buildDocx({ body: p("Hello world") + p("Second") })), () => undefined)
		const editor = await editing.editor
		const input = editing.saveInput()

		if (input === undefined) throw new Error("no save input")

		expect(editing.proofLocked()).toBe(0)

		const state = editor.state

		editor.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 6)).insertText(","))
		expect(editor.session.snapshot().dirty).toBe(true)
		expect(input.sessions).toContain(editor.session)

		const written = input.sessions.map(story => story.state.doc)
		const result = await saveDocx(input)

		if (result.bytes === undefined) throw new Error("no bytes")

		input.sessions.forEach((story, index) => {
			const doc = written[index]

			if (doc !== undefined) story.markSaved(doc)
		})
		expect(editor.session.snapshot().dirty).toBe(false)

		const reopened = await openBytes(result.bytes)
		const body = reopened.model.body

		expect(body).toBeDefined()
		expect(result.changedParts).toContain("word/document.xml")

		const check = new DocxEditorSession(reopened.context)

		expect(nodeText(check.state.doc.child(0))).toBe("Hello, world")
		session.close()
	})
	it("holds overlay merges while a save runs", async () => {
		const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
		const seen: { held: boolean[]; parts: number[] } = { held: [], parts: [] }
		let parts: () => number = () => 0
		let held: () => boolean = () => false
		const editing = inThreadEditingHost(() => services({ count: 0 }), {
			writer: {
				async prepare(input, options) {
					// A merge due now would run in this wait if the save did not hold it off.
					await pause(60)
					seen.held.push(held())
					seen.parts.push(parts())

					return prepareDocxSave(input, options)
				}
			}
		})
		const session = editing.host(
			bytesSource(buildDocx({ body: Array.from({ length: 40 }, (_, k) => p(`Paragraph ${String(k)}`)).join("") })),
			() => undefined
		)
		const editor = await editing.editor
		const edits = editor.edits

		parts = () => new Set([...edits.overlayRecords()].map(record => record.part)).size
		held = () => edits.compactHeld()
		edits.compaction = { ...edits.compaction, parts: 3, minimum: 2, quietMs: 0 }

		// Typed with merges held: one overlay part per edit.
		const release = edits.holdCompaction()

		for (let k = 0; k < 6; k++) {
			let at = -1
			let index = 0

			editor.state.doc.forEach((_node, offset) => {
				if (index++ === k * 5) at = offset + 3
			})
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).insertText("typed "))
			await editor.whenSettled()
		}

		const before = parts()

		expect(before).toBeGreaterThanOrEqual(3)
		release()

		const saving = editing.save()

		expect(held()).toBe(true)
		await saving
		expect(seen.held).toEqual([true])
		expect(seen.parts).toEqual([before])
		expect(parts()).toBe(before)
		expect(held()).toBe(false)

		// Released: the merge the save held off runs.
		await pause(200)
		await editor.whenSettled()
		expect(parts()).toBeLessThan(before)
		session.close()
	})
})
