import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { prepareDocxSave, writerProof } from "@filen/office/core/docx/write"
import type { DocxEngineServices } from "@filen/office/dom/docx"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"
import { buildDocx, p } from "./docxSynthetic"
import { engineServices } from "./engineFixtures"

// A write of the editor's document (Download as from the editor) given a signal: an abort before or while it runs ends
// it at its next slice or stage and hands nothing out; the editor and later saves are unaffected.

function services(onPause: () => void): DocxEngineServices {
	return engineServices({
		yield: () => {
			onPause()

			return Promise.resolve()
		},
		sliceMs: 0
	})
}

const BODY = Array.from({ length: 60 }, (_, k) => p(`Paragraph ${String(k)}`)).join("")

describe("a write of the editor's document with a signal", () => {
	it("rejects as aborted, before it starts or at its next slice, and a later save still writes", async () => {
		const state = { pauses: 0, abortAt: Infinity, controller: new AbortController() }
		const editing = inThreadEditingHost(
			() =>
				services(() => {
					if (++state.pauses >= state.abortAt) state.controller.abort()
				}),
			{ proof: writerProof, writer: { prepare: prepareDocxSave } }
		)
		const session = editing.host(bytesSource(buildDocx({ body: BODY })), () => undefined)
		const editor = await editing.editor

		editor.session.dispatch(editor.session.state.tr.insertText("Edited ", 1))

		const before = new AbortController()

		before.abort()
		await expect(editing.save(undefined, { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" })

		state.abortAt = state.pauses + 2
		await expect(editing.save(undefined, { signal: state.controller.signal })).rejects.toMatchObject({ name: "AbortError" })

		const written = await editing.save()

		expect(written.bytes.length).toBeGreaterThan(0)
		expect(editor.session.snapshot().dirty).toBe(true)
		session.close()
	})
})
