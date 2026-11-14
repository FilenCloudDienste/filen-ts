import { describe, expect, it } from "vitest"
import { createFormWidgetScope, pdfFormControlProps, type PdfFormControlField } from "../dom/pdf/formWidgets"

// The PDF editor's form overlay controls: never a credential field, never a document-chosen name or id, the /TU as
// accessible name, grouping kept per document.

const base: PdfFormControlField = {
	name: "field",
	kind: "text",
	label: "",
	password: false,
	multiline: false,
	readOnly: false,
	required: false,
	maxLength: 0,
	multiSelect: false
}

function control(overrides: Partial<PdfFormControlField>, scope = createFormWidgetScope()) {
	return pdfFormControlProps({ ...base, ...overrides }, scope, "Form field")
}

describe("pdfFormControlProps", () => {
	it("makes a password field a masked text input that password managers skip", () => {
		const props = control({ name: "password", label: "Password", password: true })

		expect(props.element).toBe("input")
		expect(props.type).toBe("text")
		expect(props.masked).toBe(true)
		expect(props.autoComplete).toBe("off")
		expect(props["data-1p-ignore"]).toBe("true")
		expect(props["data-lpignore"]).toBe("true")
		expect(props["data-bwignore"]).toBe("true")
		expect(props["data-form-type"]).toBe("other")
		expect(props["data-protonpass-ignore"]).toBe("true")
		expect(props["data-filen-hardened"]).toBe("")
		expect(Object.values(props)).not.toContain("password")
	})

	it("never outputs the document's field name or id", () => {
		const props = control({ name: "login.password" })

		expect(props.name).toMatch(/^pdfField-\d+$/u)
		expect(props.id).toMatch(/^pdfFieldId-\d+$/u)
		expect(JSON.stringify(props)).not.toContain("login")
	})

	it("keeps one document field one name across pages, and two fields apart", () => {
		const scope = createFormWidgetScope()
		const first = control({ name: "choice", kind: "radio" }, scope)
		const second = control({ name: "choice", kind: "radio" }, scope)
		const other = control({ name: "agree", kind: "checkbox" }, scope)

		expect(first.name).toBe(second.name)
		expect(first.id).not.toBe(second.id)
		expect(other.name).not.toBe(first.name)
		expect(first.type).toBe("radio")
		expect(other.type).toBe("checkbox")
	})

	it("names the control from /TU, else the generic label", () => {
		expect(control({ label: "  Full name " })["aria-label"]).toBe("Full name")
		expect(control({ name: "password" })["aria-label"]).toBe("Form field")
	})

	it("maps the field flags", () => {
		expect(control({ multiline: true }).element).toBe("textarea")
		expect(control({ multiline: true, password: true }).element).toBe("input")
		expect(control({ maxLength: 5 }).maxLength).toBe(5)
		expect(control({}).maxLength).toBeUndefined()
		expect(control({ required: true }).required).toBe(true)
		expect(control({ readOnly: true })).toMatchObject({ readOnly: true, disabled: false })
		expect(control({ readOnly: true, kind: "checkbox" })).toMatchObject({ readOnly: false, disabled: true })
		expect(control({ kind: "list", multiSelect: true })).toMatchObject({ element: "select", multiple: true })
		expect(control({ kind: "combo" })).toMatchObject({ element: "select", multiple: false })
		expect(control({ kind: "combo" }).type).toBeUndefined()
	})
})
