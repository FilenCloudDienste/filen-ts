// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { PasswordGate } from "@/features/publicLinks/components/passwordGate"

// The one field-error association rendered as a unit test: the remaining six sites (auth forms,
// settings) are the same three-token edit over the same primitive and are covered by tsc + lint.
function renderGate(state: "prompt" | "checking" | "wrong") {
	return render(
		createElement(PasswordGate, {
			state,
			onSubmit: () => {
				// no-op — the association, not the submit flow, is under test
			}
		})
	)
}

afterEach(() => {
	cleanup()
})

describe("PasswordGate — field error association", () => {
	it("points the password input's aria-describedby at the rendered error, which is a live alert", () => {
		const { container, getByRole } = renderGate("wrong")

		const input = container.querySelector("#public-link-password")
		const error = container.querySelector('[data-slot="field-error"]')

		expect(error).not.toBeNull()
		expect(input?.getAttribute("aria-describedby")).toBe(error?.id)
		expect(getByRole("alert").textContent).toBe("Wrong password. Please try again.")
	})

	it("renders no alert and no dangling description in the prompt state", () => {
		const { container, queryByRole } = renderGate("prompt")

		expect(queryByRole("alert")).toBeNull()
		expect(container.querySelector("#public-link-password")?.hasAttribute("aria-describedby")).toBe(false)
	})

	it("leaks no association while a submitted password is being checked either", () => {
		const { container, queryByRole } = renderGate("checking")

		expect(queryByRole("alert")).toBeNull()
		expect(container.querySelector("#public-link-password")?.hasAttribute("aria-describedby")).toBe(false)
	})

	it("flips aria-invalid and aria-describedby together — one condition drives both", () => {
		const prompt = renderGate("prompt")
		const promptInput = prompt.container.querySelector("#public-link-password")

		expect(promptInput?.getAttribute("aria-invalid")).toBe("false")
		expect(promptInput?.hasAttribute("aria-describedby")).toBe(false)

		cleanup()

		const wrong = renderGate("wrong")
		const wrongInput = wrong.container.querySelector("#public-link-password")

		expect(wrongInput?.getAttribute("aria-invalid")).toBe("true")
		expect(wrongInput?.getAttribute("aria-describedby")).toBe("public-link-password-error")
	})
})
