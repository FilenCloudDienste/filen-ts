// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { pdfViewerKey } from "@/features/preview/lib/pdfKeys.logic"
import { pdfToolLetterAllowed } from "@/features/pdf/lib/toolKeys"

// A letter typed into a field over the PDF (a form field, a text box being edited, a select) is typed there: the
// viewer's N, P and F and the tools' letters never take it, while on the page they still act.

afterEach(() => {
	document.body.replaceChildren()
})

function press(key: string, target: EventTarget, change: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
	return { key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target, ...change }
}

function surfaceWith(html: string): { surface: HTMLElement; field: Element } {
	const surface = document.createElement("div")

	surface.innerHTML = `<div class="page" tabindex="0"></div><div class="overlay">${html}</div>`
	document.body.append(surface)

	const field = surface.querySelector(".overlay > *")

	if (field === null) throw new Error("no field")

	return { surface, field }
}

const FIELDS = [
	'<input type="text">',
	"<textarea></textarea>",
	"<select><option>a</option></select>",
	'<div contenteditable="true"><span>text</span></div>',
	'<div role="textbox"></div>'
]

describe("letters typed into a field over the PDF", () => {
	it.each(FIELDS)("are typed into %s, not taken by the viewer or a tool", html => {
		const { surface, field } = surfaceWith(html)
		const target = field.firstElementChild ?? field

		for (const letter of ["n", "p", "f", "N"]) {
			expect(pdfViewerKey(press(letter, target, { shiftKey: letter === "N" }), {}, false)).toBeUndefined()
		}

		expect(pdfToolLetterAllowed(target, surface)).toBe(false)
	})

	it("stay the viewer's keys on the page, and the viewer's zoom keeps Ctrl+= in a field", () => {
		const { surface, field } = surfaceWith('<input type="text">')
		const page = surface.querySelector(".page")

		if (page === null) throw new Error("no page")

		expect(pdfViewerKey(press("n", page), {}, false)).toBe("preview.pdfNextPage")
		expect(pdfViewerKey(press("p", page), {}, false)).toBe("preview.pdfPreviousPage")
		expect(pdfToolLetterAllowed(page, surface)).toBe(true)
		expect(
			pdfViewerKey(
				{ key: "=", code: "Equal", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: field },
				{},
				false
			)
		).toBe("preview.pdfZoomIn")
	})
})
