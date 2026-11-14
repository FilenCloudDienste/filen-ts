import { describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import type { PdfEditState, PdfWidgetSummary } from "@filen/office/core/pdfedit"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import { PdfEditSwap } from "@/features/pdf/session/swap"
import { engineFields, fieldChecked, pdfjsFields } from "@/features/pdf/session/fieldOverlay.logic"

vi.mock("@/features/pdf/session/engineModule", () => ({ prefetchPdfEngine: () => undefined }))

const STATE = { revision: 0, pageCount: 2, dirty: false, restrictions: { owner: false } } as unknown as PdfEditState

function fakeEngine(calls: string[]): PdfEngine {
	const call = (op: string): Promise<unknown> => {
		calls.push(op)

		return Promise.resolve(
			op === "state" ? STATE : { pages: [0], state: { ...STATE, revision: calls.length, dirty: true }, widgets: [] }
		)
	}

	return {
		client: { call, queued: (op: string) => ({ promise: call(op), cancel: () => undefined }) } as unknown as PdfEngine["client"],
		opened: { status: "open", access: "none", document: {} as never },
		close: () => Promise.resolve({ heapBytes: 0 })
	}
}

const FILE = { uuid: "f" } as unknown as AnyFile

describe("the swap to the editor", () => {
	it("starts on the first change and runs the changes made meanwhile in order", async () => {
		const calls: string[] = []
		let opened = 0
		const swap = new PdfEditSwap({
			open: () => {
				opened++

				return Promise.resolve(fakeEngine(calls))
			},
			mobile: false,
			onChangeFailed: () => undefined
		})

		swap.setFile(FILE)
		swap.edit(session => session.dispatch("forms.reset", {}))
		swap.edit(session => session.undo())
		expect(swap.getSnapshot().kind).toBe("starting")

		await vi.waitFor(() => {
			expect(calls).toEqual(["state", "dispatch", "undo"])
		})
		expect(swap.getSnapshot().kind).toBe("editing")
		expect(opened).toBe(1)
	})

	it("says the editor is unavailable when it does not start, and tries again", async () => {
		const calls: string[] = []
		let fail = true
		const swap = new PdfEditSwap({
			open: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(fakeEngine(calls))),
			mobile: false,
			onChangeFailed: () => undefined
		})

		swap.setFile(FILE)
		swap.edit(session => session.dispatch("forms.reset", {}))
		await vi.waitFor(() => {
			expect(swap.getSnapshot().kind).toBe("failed")
		})

		fail = false
		swap.retry()
		await vi.waitFor(() => {
			expect(swap.getSnapshot().kind).toBe("editing")
		})
		// The change asked for before the failure is dropped, never replayed later.
		expect(calls).toEqual(["state"])
	})

	it("goes back to the viewer when the engine is poisoned", async () => {
		let poison: (message: string) => void = () => undefined
		const swap = new PdfEditSwap({
			open: (_file, _password, onPoisoned) => {
				poison = onPoisoned

				return Promise.resolve(fakeEngine([]))
			},
			mobile: false,
			onChangeFailed: () => undefined
		})

		swap.setFile(FILE)
		swap.warm()
		await vi.waitFor(() => {
			expect(swap.getSnapshot().kind).toBe("editing")
		})
		poison("out of memory")
		expect(swap.getSnapshot().kind).toBe("poisoned")
	})
})

describe("form fields over the page", () => {
	it("reads pdf.js widgets by their object number", () => {
		const fields = pdfjsFields([
			{ subtype: "Widget", id: "12R", fieldType: "Tx", rect: [72, 680, 300, 700], fieldValue: "Ada", maxLen: 20 },
			{ subtype: "Widget", id: "14R", fieldType: "Btn", checkBox: true, rect: [1, 2, 3, 4], fieldValue: "Yes", exportValue: "Yes" },
			{ subtype: "Widget", id: "15R", fieldType: "Btn", pushButton: true, rect: [1, 2, 3, 4] },
			{ subtype: "Widget", id: "16R", fieldType: "Sig", rect: [1, 2, 3, 4] },
			{ subtype: "Link", id: "17R", rect: [1, 2, 3, 4] },
			{ subtype: "Widget", id: "18R", fieldType: "Tx", hidden: true, rect: [1, 2, 3, 4] }
		])

		expect(fields.map(field => [field.id, field.kind, field.value])).toEqual([
			[12, "text", "Ada"],
			[14, "checkbox", "Yes"]
		])
		expect(fields[0]?.maxLength).toBe(20)
		expect(fields[1] === undefined ? false : fieldChecked(fields[1])).toBe(true)
	})

	it("reads the editor's widgets, locked fields as read-only", () => {
		const widget: PdfWidgetSummary = {
			id: 9,
			page: 0,
			rect: [0, 0, 10, 10],
			type: "radio",
			field: "choice",
			label: "Choice",
			value: "Off",
			selected: [],
			onState: "A",
			options: [],
			maxLength: 0,
			readOnly: false,
			required: false,
			multiline: false,
			password: false,
			comb: false,
			multiSelect: false,
			editable: false,
			locked: true
		}
		const [field] = engineFields([widget, { ...widget, id: 10, type: "signature" }])

		expect(field).toMatchObject({ id: 9, kind: "radio", readOnly: true })
		expect(field === undefined ? true : fieldChecked(field)).toBe(false)
	})
})
