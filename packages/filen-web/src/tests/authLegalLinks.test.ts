// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { FILEN_PRIVACY_URL, FILEN_TERMS_URL } from "@/lib/externalUrls"
import { AuthLegalLinks } from "@/features/auth/components/legalLinks"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

afterEach(() => {
	cleanup()
})

describe("AuthLegalLinks", () => {
	it("links to the shared Terms and Privacy URLs", () => {
		render(createElement(AuthLegalLinks))

		expect(screen.getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe(FILEN_TERMS_URL)
		expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe(FILEN_PRIVACY_URL)
	})

	it("opens both in a new tab with the reverse-tabnabbing guard", () => {
		render(createElement(AuthLegalLinks))

		for (const name of ["Terms of Service", "Privacy Policy"]) {
			const link = screen.getByRole("link", { name })

			expect(link.getAttribute("target")).toBe("_blank")
			expect(link.getAttribute("rel")).toBe("noopener noreferrer")
		}
	})

	// Signed-out visitors run the same bundled third-party code, so its notices are reachable without a session.
	it("opens the third party notices without a session", () => {
		// The app root provides the query client; the dialog asks it for the desktop shell's notices.
		render(createElement(AuthLegalLinks), { wrapper: queryClientWrapper(createTestQueryClient()) })

		fireEvent.click(screen.getByRole("button", { name: "Third party notices" }))

		expect(screen.getByRole("dialog", { name: "Third party notices" })).toBeDefined()
	})
})
