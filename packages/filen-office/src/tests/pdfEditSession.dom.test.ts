import { describe, expect, it, vi } from "vitest"
import type { PdfCommandResult, PdfEditState } from "../core/pdfedit/state"
import { MupdfPdfDocument, type PdfEditEngine } from "../react/pdfedit/mupdfDocument"
import { PdfEditSessionModel } from "../react/pdfedit/session"

const STATE = { revision: 1, pageCount: 1, restrictions: { owner: false } } as unknown as PdfEditState

function session(): { model: PdfEditSessionModel; call: ReturnType<typeof vi.fn> } {
	const result: PdfCommandResult = { pages: [0], state: STATE, widgets: [] }
	const call = vi.fn(() => Promise.resolve(result))
	const engine = { call, queued: vi.fn() } as unknown as PdfEditEngine
	const document = MupdfPdfDocument.open(engine, {
		pageCount: 1,
		tileSize: 256,
		facts: { info: null, permissions: null, signatures: null, outline: null }
	})

	return { model: new PdfEditSessionModel(engine, document, STATE), call }
}

describe("PdfEditSessionModel.dispatch", () => {
	it("forwards a transfer list to the engine call", async () => {
		const { model, call } = session()
		const bytes = new Uint8Array(8)

		await model.dispatch("pages.insertImage", { at: 0, bytes }, undefined, [bytes.buffer])

		expect(call).toHaveBeenCalledWith("dispatch", { command: "pages.insertImage", args: { at: 0, bytes } }, [bytes.buffer])
	})

	it("sends no transfer list when none is given", async () => {
		const { model, call } = session()

		await model.dispatch("pages.insertImage", { at: 0, bytes: new Uint8Array(1) })

		expect(call.mock.calls[0]?.[2]).toBeUndefined()
	})
})
