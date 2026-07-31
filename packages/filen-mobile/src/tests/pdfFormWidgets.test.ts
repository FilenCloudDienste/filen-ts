// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from "vitest"
import { createFormWidgetScope, hardenFormWidgets } from "@/components/pdfPreview/formWidgets"

function render(html: string): HTMLElement {
	const root = document.createElement("div")

	root.innerHTML = html

	document.body.replaceChildren(root)

	return root
}

beforeEach(() => {
	document.body.replaceChildren()
})

/**
 * The attack: a document defines a form field with the password flag set, and pdf.js faithfully
 * renders it as `<input type="password">` inside our WebView. Because the app is associated with the
 * Filen web domains for autofill, the platform's password manager may then offer the user's real
 * credential to a box an attacker drew.
 */
describe("hardenFormWidgets", () => {
	test("downgrades a password input and suppresses autofill", () => {
		const root = render('<input type="password" name="password" id="password">')

		hardenFormWidgets(root, createFormWidgetScope())

		const input = root.querySelector("input")

		expect(input?.type).toBe("text")
		expect(input?.getAttribute("autocomplete")).toBe("off")
		expect(input?.getAttribute("data-lpignore")).toBe("true")
	})

	test("rewrites the document's chosen name and id", () => {
		// Both platforms' autofill heuristics key off attribute names, so a document-chosen
		// name="password" is a hint that must not survive.
		const root = render('<input type="password" name="password" id="filen-password">')

		hardenFormWidgets(root, createFormWidgetScope())

		const input = root.querySelector("input")

		expect(input?.name).not.toBe("password")
		expect(input?.id).not.toBe("filen-password")
		expect(input?.name.startsWith("pdfField-")).toBe(true)
	})

	test("covers textarea and select, not just input", () => {
		const root = render('<textarea name="password"></textarea><select name="password"></select>')

		hardenFormWidgets(root, createFormWidgetScope())

		for (const element of [root.querySelector("textarea"), root.querySelector("select")]) {
			expect(element?.getAttribute("autocomplete")).toBe("off")
			expect(element?.name).not.toBe("password")
		}
	})

	test("is idempotent across repeated renders", () => {
		// Virtualization re-creates these elements, so the sweep runs again after every annotation-layer
		// render and on focus. Running twice must not drift.
		const root = render('<input type="password" name="password">')

		hardenFormWidgets(root, createFormWidgetScope())

		const first = root.querySelector("input")?.name

		hardenFormWidgets(root, createFormWidgetScope())

		expect(root.querySelector("input")?.name).toBe(first)
		expect(root.querySelector("input")?.type).toBe("text")
	})

	test("re-hardens an element the document re-added after the first sweep", () => {
		const root = render('<input type="password" name="password">')

		hardenFormWidgets(root, createFormWidgetScope())

		root.insertAdjacentHTML("beforeend", '<input type="password" name="password" id="late">')

		hardenFormWidgets(root, createFormWidgetScope())

		for (const input of root.querySelectorAll("input")) {
			expect(input.type).toBe("text")
			expect(input.getAttribute("autocomplete")).toBe("off")
		}
	})

	test("keeps radio groups grouped while removing the name", () => {
		// Radios are grouped BY name. A per-element index would split one group into several
		// single-option radios that can all be selected at once — a silently broken form.
		const root = render(
			'<input type="radio" name="choice" value="a"><input type="radio" name="choice" value="b"><input type="radio" name="other" value="c">'
		)

		hardenFormWidgets(root, createFormWidgetScope())

		const radios = [...root.querySelectorAll("input")]

		expect(radios[0]?.name).toBe(radios[1]?.name)
		expect(radios[0]?.name).not.toBe("choice")
		expect(radios[2]?.name).not.toBe(radios[0]?.name)
	})

	test("never wraps widgets in a form", () => {
		// The contract verifies pdf.js creates no form element; adding one here would manufacture the
		// very thing the check looks for.
		const root = render('<input type="password">')

		hardenFormWidgets(root, createFormWidgetScope())

		expect(root.querySelector("form")).toBeNull()
	})

	test("leaves ordinary text fields usable", () => {
		const root = render('<input type="text" name="firstName" value="hello">')

		hardenFormWidgets(root, createFormWidgetScope())

		const input = root.querySelector("input")

		expect(input?.type).toBe("text")
		expect(input?.value).toBe("hello")
		expect(input?.disabled).toBe(false)
	})

	test("re-sweeping a widget leaves it exactly as it was", () => {
		// Production sweeps the SAME element more than once: once per page render, and again on focus.
		// A non-idempotent sweep renamed the widget on every focus, detaching a radio from its group —
		// the corruption this scope was introduced to prevent. Note the shared scope: an earlier version
		// of this test built a fresh one per sweep, the one configuration production never uses, and so
		// passed against the broken implementation.
		const scope = createFormWidgetScope()
		const root = render('<input type="radio" name="choice" id="a"><input type="radio" name="choice" id="b">')

		hardenFormWidgets(root, scope)

		const afterFirst = Array.from(root.querySelectorAll("input")).map(input => `${input.name}#${input.id}`)

		// Focus-time re-harden of one widget, exactly as the viewer does it.
		hardenFormWidgets(root.querySelector("#" + CSS.escape(afterFirst[1]?.split("#")[1] ?? ""))?.parentNode ?? root, scope)
		hardenFormWidgets(root, scope)

		expect(Array.from(root.querySelectorAll("input")).map(input => `${input.name}#${input.id}`)).toEqual(afterFirst)
	})

	test("does not reuse a replacement name across separate sweeps of one document", () => {
		// The sweep runs once per RENDERED PAGE, and adjacent pages are mounted together (the page
		// observer keeps a viewport of lookahead each way). A per-sweep counter therefore handed page 2's
		// first named field the same replacement as page 1's. pdf.js creates no <form>, so same-named
		// widgets group across the whole document and its change handler resolves them through
		// document.getElementsByName — so ticking a box on one page cleared the collided one on another,
		// in the DOM and in the annotation storage a save serialises from.
		const scope = createFormWidgetScope()

		const pageOne = render('<input type="checkbox" name="agree" id="a">')

		hardenFormWidgets(pageOne, scope)

		const first = pageOne.querySelector("input")?.name

		const pageTwo = render('<input type="checkbox" name="subscribe" id="b">')

		hardenFormWidgets(pageTwo, scope)

		const second = pageTwo.querySelector("input")?.name

		expect(first).toBeTruthy()
		expect(second).toBeTruthy()
		expect(second).not.toBe(first)
	})

	test("gives one original name the same replacement in every sweep", () => {
		// The other half: a radio group legitimately spans pages, and a field with the same name IS the
		// same field. Splitting it would let two options of one group be selected at once.
		const scope = createFormWidgetScope()

		const pageOne = render('<input type="radio" name="choice" id="a">')

		hardenFormWidgets(pageOne, scope)

		const pageTwo = render('<input type="radio" name="choice" id="b">')

		hardenFormWidgets(pageTwo, scope)

		expect(pageTwo.querySelector("input")?.name).toBe(pageOne.querySelector("input")?.name)
	})

	test("keeps ids unique across sweeps", () => {
		// Duplicate ids in one document break label association and getElementById.
		const scope = createFormWidgetScope()

		const pageOne = render('<input type="text" name="one" id="x">')

		hardenFormWidgets(pageOne, scope)

		const pageTwo = render('<input type="text" name="two" id="y">')

		hardenFormWidgets(pageTwo, scope)

		expect(pageTwo.querySelector("input")?.id).not.toBe(pageOne.querySelector("input")?.id)
	})
})
