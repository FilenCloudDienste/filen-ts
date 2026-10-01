// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { SecretInput } from "@/components/ui/secretInput"

describe("SecretInput", () => {
	it("is masked without being a password field, and opts out of password managers", () => {
		render(<SecretInput aria-label="Link password" />)

		const input = screen.getByLabelText("Link password")

		expect(input.getAttribute("type")).toBe("text")
		expect(input.getAttribute("autocomplete")).toBe("off")
		expect(input.className).toContain("[-webkit-text-security:disc]")

		for (const attribute of ["data-1p-ignore", "data-lpignore", "data-bwignore", "data-protonpass-ignore"]) {
			expect(input.getAttribute(attribute)).toBe("true")
		}

		expect(input.getAttribute("data-form-type")).toBe("other")
	})
})
