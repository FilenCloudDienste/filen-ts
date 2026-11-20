// @vitest-environment jsdom

// The password-reset page reads its token from the fragment (`/reset#<token>`, what the previous web app's
// `#/reset/<token>` email link is rewritten to), hands it to the form, and takes it out of the address bar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement, type ComponentType, type ReactNode } from "react"
import "@/lib/i18n"

const { navigate, resetFormToken } = vi.hoisted(() => ({ navigate: vi.fn(), resetFormToken: vi.fn() }))

vi.mock("@tanstack/react-router", async importOriginal => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigate
}))
vi.mock("@/lib/sdk/boot", () => ({ whenBootReady: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient: vi.fn() } }))
vi.mock("@/features/auth/components/resetForm", () => ({
	ResetForm: ({ token }: { token: string }) => {
		resetFormToken(token)

		return createElement("p", null, "reset form")
	}
}))
vi.mock("@/features/auth/components/authCard", () => ({
	AuthCard: ({ children }: { children: ReactNode }) => createElement("main", null, children)
}))

const { Route } = await import("@/routes/reset")
const { resetTokenFromHash } = await import("@/features/auth/lib/resetToken.logic")
const { legacyUrlTarget } = await import("@/lib/legacyUrl.logic")

const TOKEN = "f3a9c1d2e4b5a6c7d8e9f0a1b2c3d4e5"

function renderPage(): void {
	const component = Route.options.component as ComponentType

	render(createElement(component))
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
	window.history.replaceState(null, "", "/")
})

describe("/reset", () => {
	it("opens the form with the token from the fragment and drops it from the address", () => {
		window.history.replaceState(null, "", `/reset#${TOKEN}`)

		renderPage()

		expect(resetFormToken).toHaveBeenCalledWith(TOKEN)
		expect(navigate).toHaveBeenCalledWith({ to: "/reset", replace: true })
	})

	it("opens the form for the previous web app's email link, after the pre-router rewrite", () => {
		const target = legacyUrlTarget({ pathname: "/", search: "", hash: `#/reset/${TOKEN}` })

		expect(target).toBe(`/reset#${TOKEN}`)

		window.history.replaceState(null, "", target)
		renderPage()

		expect(resetFormToken).toHaveBeenCalledWith(TOKEN)
	})

	it("explains a link without a token instead of showing the form", () => {
		window.history.replaceState(null, "", "/reset")

		renderPage()

		expect(resetFormToken).not.toHaveBeenCalled()
		expect(screen.getByText("This reset link is incomplete")).toBeTruthy()
		expect(navigate).not.toHaveBeenCalled()
	})
})

describe("resetTokenFromHash", () => {
	it("takes a token from a fragment, with or without its #", () => {
		expect(resetTokenFromHash(`#${TOKEN}`)).toBe(TOKEN)
		expect(resetTokenFromHash(TOKEN)).toBe(TOKEN)
	})

	it.each(["", "#", "#a/b", "#a b", "#a?b", "#a#b", "#a\\b", `#${"x".repeat(1025)}`])("rejects %j", hash => {
		expect(resetTokenFromHash(hash)).toBeNull()
	})
})
