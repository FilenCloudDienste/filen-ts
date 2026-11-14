// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { PageViewport, type PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfWidgetSummary } from "@filen/office/core/pdfedit"
import { fakeToolContext } from "@/tests/support/pdfToolContext"
import "@/lib/i18n"

// Forms and Fill & Sign on the page: the field controls follow the hardening contract (opaque names shared by a radio
// group across pages, never type=password, a password field masked and refusing typing), commit one step per edit;
// the save gate asks before dropping XFA and warns about empty required fields; the Fill & Sign overlay places by
// pointer and by keyboard in MuPDF's page space.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/office/lib/officeSettings", () => ({ useOfficeSettings: () => ({ authorName: "Jane Doe" }) }))

const { PdfFieldOverlay } = await import("@/features/pdf/session/fieldOverlay")
const { combSpacing, controlField, engineFields, fieldEmpty, pdfjsFields } = await import("@/features/pdf/session/fieldOverlay.logic")
const { pdfFormSaveGate } = await import("@/features/pdf/forms/formSave")
const { FillSignOverlay } = await import("@/features/pdf/fillSign/fillSignPlacement")
const { PdfLiveRegion } = await import("@/features/pdf/tools/pdfLiveRegion")
const { markSize, pageBox, signatureSize, textBox } = await import("@/features/pdf/fillSign/fillSign.logic")

afterEach(cleanup)

const ANNOTATIONS: Record<number, unknown[]> = {
	1: [
		{
			subtype: "Widget",
			id: "10R",
			fieldType: "Tx",
			fieldName: "name",
			alternativeText: "Full name",
			rect: [72, 740, 300, 760],
			fieldValue: ""
		},
		{
			subtype: "Widget",
			id: "11R",
			fieldType: "Tx",
			fieldName: "password",
			alternativeText: "Password",
			password: true,
			rect: [72, 570, 300, 590],
			fieldValue: ""
		},
		{
			subtype: "Widget",
			id: "12R",
			fieldType: "Btn",
			radioButton: true,
			fieldName: "choice",
			alternativeText: "Choice",
			buttonValue: "A",
			rect: [72, 450, 88, 466],
			fieldValue: "Off"
		},
		{
			subtype: "Widget",
			id: "13R",
			fieldType: "Ch",
			combo: true,
			fieldFlags: 1 << 18,
			fieldName: "city",
			alternativeText: "City",
			rect: [72, 380, 240, 400],
			fieldValue: [],
			options: [{ exportValue: "Berlin", displayValue: "Berlin" }]
		}
	],
	2: [
		{
			subtype: "Widget",
			id: "20R",
			fieldType: "Btn",
			radioButton: true,
			fieldName: "choice",
			alternativeText: "Choice",
			buttonValue: "B",
			rect: [72, 740, 88, 756],
			fieldValue: "Off"
		}
	]
}

function pdfjsDocument(): PdfDomDocument {
	return {
		numPages: 2,
		getPage: (page: number) => Promise.resolve({ getAnnotations: () => Promise.resolve(ANNOTATIONS[page] ?? []) })
	} as unknown as PdfDomDocument
}

function fakeSession() {
	const dispatch = vi.fn((_command: string, _args: unknown) => Promise.resolve({ pages: [], state: {}, widgets: [] }))

	return { dispatch, session: { dispatch } as unknown as PdfEditSessionModel }
}

function fakeSwap(session: PdfEditSessionModel) {
	return {
		prefetch: vi.fn(),
		warm: vi.fn(),
		withSession: vi.fn(),
		edit: vi.fn((change: (session: PdfEditSessionModel) => Promise<unknown>) => {
			void change(session)
		})
	}
}

const VIEWPORT = new PageViewport({ viewBox: [0, 0, 612, 792], scale: 1, rotation: 0 })

describe("form field controls", () => {
	it("are hardened, group radio buttons across pages and commit one step per edit", async () => {
		const { dispatch, session } = fakeSession()
		const swap = fakeSwap(session)
		const document = pdfjsDocument()
		const overlay = (page: number) => (
			<PdfFieldOverlay
				document={document}
				page={page}
				viewport={VIEWPORT}
				swap={swap as never}
				snapshot={null}
				starting={false}
				editable
			/>
		)

		const { container } = render(
			<div>
				{overlay(1)}
				{overlay(2)}
			</div>
		)

		const name = await screen.findByRole("textbox", { name: "Full name" })
		const password = screen.getByRole("textbox", { name: "Password" })
		const radios = screen.getAllByRole("radio", { name: "Choice" })
		const city = screen.getByRole("combobox", { name: "City" })

		expect(container.querySelector("form, input[type=password]")).toBeNull()
		expect(name.getAttribute("name")).toMatch(/^pdfField-\d+$/u)
		expect(name.getAttribute("autocomplete")).toBe("off")
		expect(name.getAttribute("data-1p-ignore")).toBe("true")
		expect(password.getAttribute("type")).toBe("text")
		expect(password.hasAttribute("readonly")).toBe(true)
		expect(password.className).toContain("fo-pdf-masked")
		expect(radios).toHaveLength(2)
		expect(radios[0]?.getAttribute("name")).toBe(radios[1]?.getAttribute("name"))
		expect(city.getAttribute("list")).toBe(`${city.id}-options`)

		fireEvent.change(name, { target: { value: "Ada" } })
		expect(swap.warm).toHaveBeenCalled()
		fireEvent.keyDown(name, { key: "Enter" })
		expect(dispatch).toHaveBeenLastCalledWith("forms.setField", { page: 0, widget: 10, value: { kind: "text", text: "Ada" } })

		const second = radios[1]

		if (second === undefined) throw new Error("no radio")

		fireEvent.click(second)
		expect(dispatch).toHaveBeenLastCalledWith("forms.setField", { page: 1, widget: 20, value: { kind: "radio" } })

		// Typing into the password field is refused: nothing is dispatched.
		const before = dispatch.mock.calls.length

		fireEvent.keyDown(password, { key: "s" })
		expect(dispatch.mock.calls.length).toBe(before)
	})
})

describe("form fields from either engine", () => {
	it("reads choices, flags and the editable combo box", () => {
		const fields = pdfjsFields(ANNOTATIONS[1] ?? [])

		expect(fields.map(field => [field.id, field.kind, field.name])).toEqual([
			[10, "text", "name"],
			[11, "text", "password"],
			[12, "radio", "choice"],
			[13, "combo", "city"]
		])
		expect(fields[1]).toMatchObject({ password: true })
		expect(fields[3]).toMatchObject({ editable: true, options: [{ value: "Berlin", label: "Berlin" }], selected: [] })

		const city = fields[3]

		if (city === undefined) throw new Error("no city")

		// An editable combo box is a text input; a password field is read-only.
		expect(controlField(city).kind).toBe("text")
		expect(controlField({ ...city, kind: "text", password: true }).readOnly).toBe(true)
		expect(fieldEmpty(city)).toBe(true)
		expect(combSpacing(120, 6, 10)).toEqual({ letterSpacing: 14, paddingLeft: 7 })
	})

	it("takes the editor's widgets in their order, locked ones read-only", () => {
		const widget: PdfWidgetSummary = {
			id: 9,
			page: 0,
			rect: [0, 0, 10, 10],
			type: "listbox",
			field: "toppings",
			label: "Toppings",
			value: "Ham",
			selected: ["Ham", "Olives"],
			onState: null,
			options: [
				{ value: "Ham", label: "Ham" },
				{ value: "Olives", label: "Olives" }
			],
			maxLength: 0,
			readOnly: false,
			required: true,
			multiline: false,
			password: false,
			comb: false,
			multiSelect: true,
			editable: false,
			locked: true
		}

		expect(engineFields([widget])).toEqual([
			expect.objectContaining({ id: 9, kind: "list", selected: ["Ham", "Olives"], multiSelect: true, readOnly: true, required: true })
		])
	})
})

describe("the form's save gate", () => {
	function gateSession(xfa: string, required: number) {
		const state = { form: { fields: 3, scripts: false, xfa } }
		const dispatch = vi.fn(() => {
			state.form.xfa = "none"

			return Promise.resolve({})
		})
		const call = vi.fn(() => Promise.resolve({ count: required, first: null }))

		return { dispatch, call, session: { getSnapshot: () => ({ state }), dispatch, engine: { call } } as unknown as PdfEditSessionModel }
	}

	it("asks before dropping a hybrid form's XFA, then removes it as a step", async () => {
		const { dispatch, session } = gateSession("hybrid", 0)
		const askXfa = vi.fn(() => Promise.resolve("copy" as const))

		expect(await pdfFormSaveGate(session, "version", { askXfa, warnRequired: vi.fn() })).toBe("copy")
		expect(dispatch).toHaveBeenCalledWith("forms.removeXfa", {})

		// Asked once: the next save goes straight through.
		expect(await pdfFormSaveGate(session, "version", { askXfa, warnRequired: vi.fn() })).toBe("version")
		expect(askXfa).toHaveBeenCalledTimes(1)
	})

	it("cancels without changing anything, and warns about empty required fields", async () => {
		const cancelled = gateSession("hybrid", 2)

		expect(
			await pdfFormSaveGate(cancelled.session, "version", { askXfa: () => Promise.resolve("cancel"), warnRequired: vi.fn() })
		).toBe("cancel")
		expect(cancelled.dispatch).not.toHaveBeenCalled()

		const plain = gateSession("none", 2)
		const warnRequired = vi.fn()

		expect(await pdfFormSaveGate(plain.session, "copy", { askXfa: vi.fn(), warnRequired })).toBe("copy")
		expect(warnRequired).toHaveBeenCalledWith(2)
	})
})

describe("Fill & Sign placement", () => {
	it("sizes marks, signatures and text, in MuPDF's page space", () => {
		expect(markSize("check")).toEqual({ width: 14, height: 14 })
		expect(signatureSize({ kind: "image", png: new Uint8Array(), width: 300, height: 100 }, "signature")).toEqual({
			width: 160,
			height: 160 / 3
		})
		// Tall initials are capped by height.
		expect(signatureSize({ kind: "image", png: new Uint8Array(), width: 100, height: 100 }, "initials")).toEqual({
			width: 40,
			height: 40
		})
		expect(pageBox({ x: 10, y: 700, width: 20, height: 30 }, 792)).toEqual([10, 62, 30, 92])
		expect(textBox({ x: 10, y: 700, width: 160, height: 20 }, [100, 50], 12)).toMatchObject({ x: 10, y: 720 - 32.8 })
	})

	function renderOverlay(mode: Parameters<typeof FillSignOverlay>[0]["mode"]) {
		const { dispatch, session } = fakeSession()
		const finish = vi.fn()
		const context = fakeToolContext({
			finish,
			edit: vi.fn((change: (session: PdfEditSessionModel) => Promise<unknown>) => {
				void change(session)
			})
		})

		render(
			<div style={{ position: "relative", width: 612, height: 792 }}>
				<PdfLiveRegion owner={context.swap} />
				<FillSignOverlay
					mode={mode}
					context={context}
					page={1}
					viewport={VIEWPORT}
					widgets={null}
					editing
					document={pdfjsDocument()}
					variant={null}
				/>
			</div>
		)

		return { dispatch, finish, surface: screen.getByRole("application", { name: "Place on page 2" }) }
	}

	it("places a mark where clicked, centred", () => {
		const { dispatch, surface } = renderOverlay({ kind: "mark", mark: "check" })

		fireEvent.click(surface, { clientX: 100, clientY: 100 })
		expect(dispatch).toHaveBeenCalledWith("fillSign.mark", {
			page: 1,
			box: [93, 93, 107, 107],
			mark: "check",
			color: [0, 0, 0],
			author: "Jane Doe"
		})
	})

	it("places from the keyboard: Enter at the centre, arrows move, Enter places; Escape ends the tool", async () => {
		const { dispatch, finish, surface } = renderOverlay({ kind: "mark", mark: "cross" })

		act(() => {
			surface.focus()
		})
		fireEvent.keyDown(surface, { key: "Enter" })
		await waitFor(() => {
			expect(screen.getByRole("status").textContent).toContain("pt")
		})
		fireEvent.keyDown(surface, { key: "ArrowRight", shiftKey: true })
		fireEvent.keyDown(surface, { key: "Enter" })
		// 12 pt centred on the page centre (306, 396), moved 10 pt right.
		expect(dispatch).toHaveBeenCalledWith("fillSign.mark", expect.objectContaining({ box: [310, 390, 322, 402], mark: "cross" }))

		fireEvent.keyDown(surface, { key: "Escape" })
		expect(finish).toHaveBeenCalled()
	})

	it("opens a text box where clicked and adds the text on Enter", async () => {
		const { dispatch, surface } = renderOverlay({ kind: "text" })

		fireEvent.click(surface, { clientX: 300, clientY: 200 })

		const editor = await screen.findByRole("textbox", { name: "Text to add" })

		fireEvent.change(editor, { target: { value: "Signed in Berlin" } })
		fireEvent.keyDown(editor, { key: "Enter" })
		expect(dispatch).toHaveBeenCalledWith(
			"fillSign.text",
			expect.objectContaining({ page: 1, text: "Signed in Berlin", font: "sans", size: 12, author: "Jane Doe" })
		)
	})
})
