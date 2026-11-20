// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isRedirect } from "@tanstack/react-router"

// The page a signed-out visit asked for survives sign-in: the `_app` guard remembers it, and the sign-in form and the
// unauthed pages' guard (redirectIfAuthed) both take it. The form navigates with the same takeSignInTarget result the
// guard redirects with, so the guard's redirect stands for both.

const { hasClient, whenBootReady } = vi.hoisted(() => ({ hasClient: vi.fn(), whenBootReady: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient } }))
vi.mock("@/lib/sdk/boot", () => ({ whenBootReady }))
vi.mock("@/features/shell/components/appShell", () => ({ AppShell: () => null }))

import { Route as AppRoute } from "@/routes/_app/route"
import { navigateAfterSignIn, redirectIfAuthed } from "@/features/auth/lib/guard"
import { rememberPlansTarget, rememberReturnTarget, safeReturnPath, takeSignInTarget } from "@/features/settings/lib/pendingPlans"

interface RedirectOptions {
	to?: string
	href?: string
	search?: unknown
	params?: unknown
}

const appBeforeLoad = AppRoute.options.beforeLoad as unknown as (ctx: {
	location: { pathname: string; href: string; search: Record<string, unknown> }
}) => Promise<void>

async function rejectionOf(run: () => Promise<void>): Promise<RedirectOptions> {
	const rejection: unknown = await run().catch((e: unknown) => e)

	expect(isRedirect(rejection)).toBe(true)

	return (rejection as { options: RedirectOptions }).options
}

// A signed-out visit to `href` through the authed layout: it bounces to /login.
async function visitSignedOut(href: string): Promise<void> {
	hasClient.mockResolvedValue(false)

	const url = new URL(href, "https://app.invalid")

	expect(
		await rejectionOf(() => appBeforeLoad({ location: { pathname: url.pathname, href, search: Object.fromEntries(url.searchParams) } }))
	).toMatchObject({ to: "/login" })
}

// The session appears (the sign-in form succeeded, or another tab signed in and /login reloads).
async function signedInRedirect(): Promise<RedirectOptions> {
	hasClient.mockResolvedValue(true)

	return rejectionOf(redirectIfAuthed)
}

beforeEach(() => {
	sessionStorage.clear()
	whenBootReady.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.clearAllMocks()
	vi.restoreAllMocks()
})

describe("sign-in return target", () => {
	it("lands a signed-out visit to a note on that note after sign-in, once", async () => {
		await visitSignedOut("/notes/x")

		expect(await signedInRedirect()).toMatchObject({ href: "/notes/x" })
		expect(await signedInRedirect()).toMatchObject({ to: "/" })
	})

	it("keeps a deep directory's search and hash", async () => {
		await visitSignedOut("/drive/a/b?sort=name#top")

		expect(takeSignInTarget()).toEqual({ kind: "path", href: "/drive/a/b?sort=name#top" })
	})

	it("falls back to the start screen when nothing was asked for", async () => {
		expect(await signedInRedirect()).toMatchObject({ to: "/" })
	})

	it("sends a form sign-in to the target, else the start screen, and clears the target", async () => {
		const navigate = vi.fn().mockResolvedValue(undefined)

		await visitSignedOut("/notes/x")
		await navigateAfterSignIn(navigate)
		await navigateAfterSignIn(navigate)

		expect(navigate).toHaveBeenNthCalledWith(1, { href: "/notes/x" })
		expect(navigate).toHaveBeenNthCalledWith(2, { to: "/" })
		expect(takeSignInTarget()).toBeNull()
	})

	it("never keeps a target outside this app", () => {
		for (const value of [
			"https://evil.example/notes",
			"//evil.example/notes",
			"/\\evil.example",
			"\\\\evil.example",
			"/\t/evil.example",
			"javascript:alert(1)",
			"notes/x",
			""
		]) {
			expect(safeReturnPath(value)).toBeNull()

			rememberReturnTarget(value)

			expect(takeSignInTarget()).toBeNull()
		}
	})

	it("ignores an outside value written to storage directly", () => {
		sessionStorage.setItem("filen.pendingTarget", "//evil.example")

		expect(takeSignInTarget()).toBeNull()
		expect(sessionStorage.getItem("filen.pendingTarget")).toBeNull()
	})

	it("does not carry the page a reload left (a sign-out reloads where the previous account was)", async () => {
		vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" } as unknown as PerformanceEntry])

		await visitSignedOut("/notes/x")

		expect(takeSignInTarget()).toBeNull()
	})

	it("does not carry a page reached by a history step (back to the previous account's pages)", async () => {
		vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "back_forward" } as unknown as PerformanceEntry])

		await visitSignedOut("/notes/x")

		expect(takeSignInTarget()).toBeNull()
	})

	it("keeps a plans link through registration, ahead of any other target", async () => {
		await visitSignedOut("/notes/x")
		await visitSignedOut("/settings/plans/27")

		// Registration and its email confirmation happen signed out: /register's guard lets them through untouched.
		hasClient.mockResolvedValue(false)
		await expect(redirectIfAuthed()).resolves.toBeUndefined()

		expect(await signedInRedirect()).toMatchObject({ to: "/settings/plans/$plan", params: { plan: "27" } })
		// Both were taken: the next sign-in lands normally.
		expect(takeSignInTarget()).toBeNull()
	})

	it("carries the plans page without a plan", async () => {
		rememberPlansTarget(undefined)

		const options = await signedInRedirect()

		expect(options).toMatchObject({ to: "/settings/plans" })
		expect(options.params).toBeUndefined()
	})

	it("keeps the bare plans page and drops a malformed plan id, never the page", async () => {
		await visitSignedOut("/settings/plans")

		expect(takeSignInTarget()).toEqual({ kind: "plans", target: {} })

		await visitSignedOut("/settings/plans/abc")

		expect(takeSignInTarget()).toEqual({ kind: "plans", target: {} })
	})

	it("remembers a moved-into-the-path page (a rewritten old bookmark) as the page to return to", async () => {
		await visitSignedOut("/contacts/blocked")

		expect(takeSignInTarget()).toEqual({ kind: "path", href: "/contacts/blocked" })
	})
})
