// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { createElement, type ReactNode } from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/lib/i18n"

const { hasClient } = vi.hoisted(() => ({ hasClient: vi.fn<() => Promise<boolean>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))
// A plain anchor stands in for the router's Link, so the rendered href shows where it points.
vi.mock("@tanstack/react-router", async () => {
	const { createElement: element, forwardRef } = await import("react")

	return {
		Link: forwardRef<HTMLAnchorElement, { to: string; params?: Record<string, string>; children?: ReactNode }>(
			({ to, params, children, ...rest }, ref) =>
				element("a", { ...rest, ref, href: to.replace("$", params?.["_splat"] ?? "") }, children)
		)
	}
})

import { queryClient } from "@/queries/client"
import { PublicLinkShell } from "@/features/publicLinks/components/publicLinkShell"

function renderShell() {
	return render(createElement(QueryClientProvider, { client: queryClient }, createElement(PublicLinkShell, null, "body")))
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
	queryClient.clear()
	consoleError = vi.spyOn(console, "error")
})

afterEach(() => {
	cleanup()
})

describe("PublicLinkShell header", () => {
	it("offers sign-in and Get Filen to a signed-out visitor", async () => {
		hasClient.mockResolvedValue(false)
		renderShell()

		await waitFor(() => {
			expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined()
		})
		expect(screen.getByRole("link", { name: "Get Filen" }).getAttribute("href")).toBe("https://filen.io")
		expect(screen.queryByRole("link", { name: "Open Cloud Drive" })).toBeNull()
	})

	it("offers a signed-in visitor the way back to Cloud Drive instead", async () => {
		hasClient.mockResolvedValue(true)
		renderShell()

		await waitFor(() => {
			expect(screen.getByRole("link", { name: "Open Cloud Drive" }).getAttribute("href")).toBe("/drive/")
		})
		expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull()
		expect(screen.queryByRole("link", { name: "Get Filen" })).toBeNull()
	})

	// A link styled as a button stays a link (buttonVariants on a real <a>), so Base UI has no
	// native-button complaint to log and assistive tech hears a link.
	it("renders its button-styled links as links, without Base UI's native-button warning", async () => {
		hasClient.mockResolvedValue(false)
		renderShell()

		await waitFor(() => {
			expect(screen.getByRole("link", { name: "Get Filen" })).toBeDefined()
		})
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain("nativeButton")
	})
})
