// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { formFillPlan, type FormFillField } from "@filen/shared/assistant"
import type { PdfWidgetSummary } from "@filen/office/core/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import "@/lib/i18n"
import { previewPdfForms } from "@/locales/en/previewPdf/forms"
import { registerAssistantFormFiller } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { AssistantFormFillRequest } from "@/features/assistant/types"
import { FormFillPanel } from "@/features/pdf/forms/formFillSurface"
import type { PdfToolContext } from "@/features/pdf/tools/registry"

// The form fill panel before the editor took the document: the page's pdf.js widgets and text read once, the details
// matched (the model's lines through the real plan), the review, then one gesture of setField calls on the editor.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }
const HEIGHT = 800
let requests: AssistantFormFillRequest[] = []
let unregister: () => void

// What the model answers, as lines over the offered fields.
let modelLines = ""

beforeEach(() => {
	requests = []
	unregister = registerAssistantFormFiller({
		run: request => {
			requests.push(request)

			return Promise.resolve({
				ok: true,
				...formFillPlan(request.fields, modelLines, request.details),
				offered: request.fields,
				left: [],
				truncated: false
			})
		},
		shutdown: () => undefined
	})
	useAssistantStore.setState({ modelState: { kind: "ready", model: MODEL } })
})

afterEach(() => {
	unregister()
	cleanup()
})

function annotation(id: number, rect: readonly number[], extra: Record<string, unknown> = {}) {
	return { subtype: "Widget", id: `${String(id)}R`, rect, fieldType: "Tx", fieldName: `f${String(id)}`, fieldValue: "", ...extra }
}

function widget(id: number): PdfWidgetSummary {
	return {
		id,
		page: 0,
		rect: [0, 0, 100, 20],
		type: "text",
		field: `f${String(id)}`,
		label: "",
		value: "",
		selected: [],
		onState: null,
		options: [],
		maxLength: 0,
		readOnly: false,
		required: false,
		multiline: false,
		password: false,
		comb: false,
		multiSelect: false,
		editable: false,
		hidden: false,
		locked: false
	}
}

function mount() {
	const viewport = {
		width: 600,
		height: HEIGHT,
		convertToViewportPoint: (x: number, y: number) => [x, HEIGHT - y]
	}
	const page = {
		getViewport: () => viewport,
		getAnnotations: () =>
			Promise.resolve([
				annotation(7, [120, 690, 320, 710]),
				annotation(8, [120, 650, 320, 670], { alternativeText: "City" }),
				annotation(9, [120, 610, 320, 630], { hidden: true, alternativeText: "Secret" })
			]),
		getTextContent: () => Promise.resolve({ items: [{ str: "Full name:", transform: [12, 0, 0, 12, 40, 694], width: 70, height: 12 }] })
	}
	const document = { getPage: () => Promise.resolve(page) } as unknown as PdfDomDocument
	const dispatch = vi.fn(() => Promise.resolve({}))
	const session = { engine: { call: () => Promise.resolve([{ page: 0, widgets: [widget(7), widget(8)] }]) }, dispatch }
	const finish = vi.fn()
	const context = {
		swap: {},
		snapshot: null,
		edit: (change: (session: unknown) => Promise<unknown>) => {
			void change(session)
		},
		finish
	} as unknown as PdfToolContext

	render(
		<FormFillPanel
			context={context}
			document={document}
			active
			phone={false}
		/>
	)

	return { dispatch, finish }
}

describe("the form fill panel", () => {
	it("matches the details to the page's labelled fields and fills them as one gesture", async () => {
		modelLines = "1: Jane Doe\n2: Berlin\n"

		const { dispatch, finish } = mount()
		const details = await screen.findByRole("textbox", { name: previewPdfForms.previewPdfFormFillDetails })

		fireEvent.change(details, { target: { value: "Jane Doe from Berlin" } })
		fireEvent.click(screen.getByRole("button", { name: previewPdfForms.previewPdfFormFillRun }))

		await screen.findByText("Will fill (2)")
		expect(requests[0]?.fields.map((field: FormFillField) => [field.id, field.label])).toEqual([
			[7, "Full name"],
			[8, "City"]
		])

		fireEvent.click(screen.getByRole("button", { name: "Fill 2 fields" }))
		await waitFor(() => {
			expect(finish).toHaveBeenCalled()
		})
		expect(dispatch.mock.calls.map(call => (call as unknown[])[1])).toEqual([
			{ page: 0, widget: 7, value: { kind: "text", text: "Jane Doe" } },
			{ page: 0, widget: 8, value: { kind: "text", text: "Berlin" } }
		])
	})

	it("never fills a value the details do not hold", async () => {
		modelLines = "1: John Smith\n2: Berlin\n"

		mount()
		fireEvent.change(await screen.findByRole("textbox", { name: previewPdfForms.previewPdfFormFillDetails }), {
			target: { value: "I live in Berlin" }
		})
		fireEvent.click(screen.getByRole("button", { name: previewPdfForms.previewPdfFormFillRun }))

		await screen.findByText("Will fill (1)")
		expect(screen.getByText(/Full name \(value not in your details\)/u)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Fill 1 field" })).toBeTruthy()
	})
})
