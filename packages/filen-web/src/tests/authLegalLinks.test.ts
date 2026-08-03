// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { FILEN_PRIVACY_URL, FILEN_TERMS_URL } from "@/lib/externalUrls"
import { AuthLegalLinks } from "@/features/auth/components/legalLinks"

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
})
