import { describe, expect, it, vi } from "vitest"
import type { PdfCommandResult, PdfEditState, PdfPageWidgets, PdfWidgetSummary } from "../core/pdfedit/state"
import { PDF_STEP_WIDGET_PAGES } from "../dom/pdfedit/protocol"
import { MupdfPdfDocument, type PdfEditEngine } from "../react/pdfedit/mupdfDocument"
import { PdfEditSessionModel } from "../react/pdfedit/session"

// Undo and redo redraw every page but read widgets only for the pages the session shows (the latest read): a shown
// page never goes without widgets (the view would fall back to the viewer's pdf.js fields, the file's original values).

const PAGES = 40
const STATE = { revision: 1, pageCount: PAGES, restrictions: { owner: false } } as unknown as PdfEditState

function widgetsFor(page: number, step: string): PdfPageWidgets {
	return { page, widgets: [{ id: `${step}-${page}` } as unknown as PdfWidgetSummary] }
}

function session() {
	const all = Array.from({ length: PAGES }, (_, index) => index)
	const call = vi.fn((op: string, args: { readonly pages?: readonly number[] }) => {
		const pages = args.pages ?? []

		return Promise.resolve(
			op === "widgets"
				? pages.map(page => widgetsFor(page, "read"))
				: ({ pages: all, state: STATE, widgets: pages.map(page => widgetsFor(page, op)) } satisfies PdfCommandResult)
		)
	})
	const engine = { call, queued: vi.fn() } as unknown as PdfEditEngine
	const document = MupdfPdfDocument.open(engine, {
		pageCount: PAGES,
		tileSize: 256,
		facts: { info: null, permissions: null, signatures: null, outline: null }
	})

	return { model: new PdfEditSessionModel(engine, document, STATE), call }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function stepPages(call: ReturnType<typeof session>["call"], op: string): unknown[] {
	return call.mock.calls.filter(([name]) => name === op).map(([, args]) => args.pages)
}

describe("PdfEditSessionModel undo and redo", () => {
	it.each(["undo", "redo"] as const)("keeps a shown page's widgets through %s, read anew in the answer", async step => {
		const { model, call } = session()
		const seen: (readonly unknown[] | undefined)[] = []

		model.want([3, 4])
		await settle()
		model.subscribe(() => {
			seen.push(model.getSnapshot().widgets.get(3))
		})

		await model[step]()

		expect(stepPages(call, step)).toEqual([[3, 4]])
		// Never absent while the step ran and after it: the answer's widgets replace the held ones.
		expect(seen.every(entry => entry !== undefined)).toBe(true)
		expect(model.getSnapshot().widgets.get(3)).toEqual([{ id: `${step}-3` }])
		expect(model.getSnapshot().widgets.get(4)).toEqual([{ id: `${step}-4` }])

		// Held, so not asked again.
		model.want([3])
		await settle()
		expect(stepPages(call, "widgets")).toEqual([[3, 4]])
	})

	it("names only the latest pages read, and a page past them is read again when it shows", async () => {
		const { model, call } = session()
		const visited = Array.from({ length: PDF_STEP_WIDGET_PAGES + 2 }, (_, index) => index)

		for (const page of visited) {
			model.want([page])
			await settle()
		}

		await model.undo()

		expect(stepPages(call, "undo")).toEqual([visited.slice(-PDF_STEP_WIDGET_PAGES)])
		expect(model.getSnapshot().widgets.has(0)).toBe(false)
		expect(model.getSnapshot().widgets.has(PDF_STEP_WIDGET_PAGES + 1)).toBe(true)

		model.want([0])
		await settle()
		expect(stepPages(call, "widgets").at(-1)).toEqual([0])
		expect(model.getSnapshot().widgets.get(0)).toEqual([{ id: "read-0" }])
	})
	it("names a page shown again after more than the cap were read, keeping its widgets through the step", async () => {
		const { model, call } = session()
		const visited = Array.from({ length: PDF_STEP_WIDGET_PAGES + 2 }, (_, index) => index)

		for (const page of visited) {
			model.want([page])
			await settle()
		}

		// Page 0 shows again: held, so marked as shown without a read.
		model.want([0])
		await settle()
		expect(stepPages(call, "widgets")).toHaveLength(visited.length)

		const seen: (readonly unknown[] | undefined)[] = []

		model.subscribe(() => {
			seen.push(model.getSnapshot().widgets.get(0))
		})

		await model.undo()

		const named = stepPages(call, "undo")[0] as readonly number[]

		expect(named).toHaveLength(PDF_STEP_WIDGET_PAGES)
		expect(named.at(-1)).toBe(0)
		expect(seen.length).toBeGreaterThan(0)
		expect(seen.every(entry => entry !== undefined)).toBe(true)
		expect(model.getSnapshot().widgets.get(0)).toEqual([{ id: "undo-0" }])
	})
})
