// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { pdfViewerKey } from "@/features/preview/lib/pdfKeys.logic"
import { FormOverlaySession, type FormDraftEdit } from "@/features/pdf/session/fieldOverlay.logic"
import { pdfToolLetterAllowed } from "@/features/pdf/lib/toolKeys"

// A letter typed into a field over the PDF (a form field, a text box being edited, a select) is typed there: the
// viewer's N, P and F and the tools' letters never take it, while on the page they still act. Text committed into a
// field is one undo step, however many ways it is committed before the editor runs it.

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

describe("text committed into a form field", () => {
	// The editor still starting: changes wait in order until `run` (as PdfEditSwap.edit queues them).
	function startingEditor() {
		const queued: { readonly change: Parameters<FormDraftEdit>[0]; readonly dropped: () => void }[] = []
		const dispatched: string[] = []
		const session = {
			dispatch: (command: string, args: unknown) => {
				dispatched.push(`${command} ${JSON.stringify(args)}`)

				return Promise.resolve(null)
			}
		} as unknown as PdfEditSessionModel
		const edit: FormDraftEdit = (change, dropped) => {
			queued.push({ change, dropped })
		}
		const run = async (): Promise<void> => {
			await Promise.all(queued.splice(0).map(({ change }) => change(session)))
		}
		const drop = (): void => {
			for (const { dropped } of queued.splice(0)) dropped()
		}

		return { edit, run, drop, dispatched }
	}

	it("is set once when Enter, leaving the field and a save all commit it before the editor started", async () => {
		const form = new FormOverlaySession()
		const editor = startingEditor()

		form.setDraft(7, { page: 1, text: "Ada" })

		// Enter, then the blur of tabbing on.
		void form.commitText(7, 1, "Ada", editor.edit)
		void form.commitText(7, 1, "Ada", editor.edit)

		// Mod+S.
		const committed = form.commitDrafts(editor.edit)

		await editor.run()
		await committed

		expect(editor.dispatched).toEqual(['forms.setField {"page":1,"widget":7,"value":{"kind":"text","text":"Ada"}}'])
		expect(form.drafted()).toBe(false)
	})

	it("is set again after the change was dropped", async () => {
		const form = new FormOverlaySession()
		const editor = startingEditor()

		form.setDraft(7, { page: 1, text: "Ada" })

		const first = form.commitText(7, 1, "Ada", editor.edit)
		const saved = form.commitDrafts(editor.edit)

		editor.drop()
		expect(await first).toBe(false)
		await saved
		expect(form.drafted()).toBe(true)

		const second = form.commitText(7, 1, "Ada", editor.edit)

		await editor.run()
		expect(await second).toBe(true)
		expect(editor.dispatched).toHaveLength(1)
	})
})
