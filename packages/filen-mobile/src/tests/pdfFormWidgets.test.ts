// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from "vitest"
import { hardenFormWidgets } from "@/components/pdfPreview/formWidgets"

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

		hardenFormWidgets(root)

		const input = root.querySelector("input")

		expect(input?.type).toBe("text")
		expect(input?.getAttribute("autocomplete")).toBe("off")
		expect(input?.getAttribute("data-lpignore")).toBe("true")
	})

	test("rewrites the document's chosen name and id", () => {
		// Both platforms' autofill heuristics key off attribute names, so a document-chosen
		// name="password" is a hint that must not survive.
		const root = render('<input type="password" name="password" id="filen-password">')

		hardenFormWidgets(root)

		const input = root.querySelector("input")

		expect(input?.name).not.toBe("password")
		expect(input?.id).not.toBe("filen-password")
		expect(input?.name.startsWith("pdfField-")).toBe(true)
	})

	test("covers textarea and select, not just input", () => {
		const root = render('<textarea name="password"></textarea><select name="password"></select>')

		hardenFormWidgets(root)

		for (const element of [root.querySelector("textarea"), root.querySelector("select")]) {
			expect(element?.getAttribute("autocomplete")).toBe("off")
			expect(element?.name).not.toBe("password")
		}
	})

	test("is idempotent across repeated renders", () => {
		// Virtualization re-creates these elements, so the sweep runs again after every annotation-layer
		// render and on focus. Running twice must not drift.
		const root = render('<input type="password" name="password">')

		hardenFormWidgets(root)

		const first = root.querySelector("input")?.name

		hardenFormWidgets(root)

		expect(root.querySelector("input")?.name).toBe(first)
		expect(root.querySelector("input")?.type).toBe("text")
	})

	test("re-hardens an element the document re-added after the first sweep", () => {
		const root = render('<input type="password" name="password">')

		hardenFormWidgets(root)

		root.insertAdjacentHTML("beforeend", '<input type="password" name="password" id="late">')

		hardenFormWidgets(root)

		for (const input of root.querySelectorAll("input")) {
			expect(input.type).toBe("text")
			expect(input.getAttribute("autocomplete")).toBe("off")
		}
	})

	test("never wraps widgets in a form", () => {
		// The contract verifies pdf.js creates no form element; adding one here would manufacture the
		// very thing the check looks for.
		const root = render('<input type="password">')

		hardenFormWidgets(root)

		expect(root.querySelector("form")).toBeNull()
	})

	test("leaves ordinary text fields usable", () => {
		const root = render('<input type="text" name="firstName" value="hello">')

		hardenFormWidgets(root)

		const input = root.querySelector("input")

		expect(input?.type).toBe("text")
		expect(input?.value).toBe("hello")
		expect(input?.disabled).toBe(false)
	})
})
