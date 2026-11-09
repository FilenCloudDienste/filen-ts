import { afterEach, describe, expect, it, vi } from "vitest"
import { isRedirect } from "@tanstack/react-router"

// resolveRootRedirect is the root route's (`/`) beforeLoad: it bounces an unauthed load to /login,
// and an authed load onward to whichever module the persisted start-screen preference names (see
// startScreen.test.ts for the preference's own get/set roundtrip — this covers the redirect switch
// itself, same split as guard.test.ts covers redirectIfAuthed). Real `redirect`/`isRedirect` from the
// router are used un-mocked below — they're pure (construct + optionally throw a tagged Response), no
// router instance needed to exercise them.

const { hasClient, whenBootReady, getStartScreen, rememberPlansTarget } = vi.hoisted(() => ({
	hasClient: vi.fn(),
	whenBootReady: vi.fn(),
	getStartScreen: vi.fn(),
	rememberPlansTarget: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient } }))
vi.mock("@/lib/sdk/boot", () => ({ whenBootReady }))
vi.mock("@/features/shell/lib/startScreen", () => ({ getStartScreen, DEFAULT_START_SCREEN: "drive" }))
vi.mock("@/features/settings/lib/pendingPlans", () => ({ rememberPlansTarget }))

async function freshModule() {
	vi.resetModules()
	return import("@/features/shell/lib/rootRedirect")
}

afterEach(() => {
	vi.clearAllMocks()
})

describe("resolveRootRedirect", () => {
	it("throws a redirect to /login when there is no active client", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(false)

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string } }).options).toMatchObject({ to: "/login" })
		expect(getStartScreen).not.toHaveBeenCalled()
	})

	it("treats a hasClient rejection as unauthed (redirect to /login, never reads the preference)", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockRejectedValue(new Error("sdk boom"))

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string } }).options).toMatchObject({ to: "/login" })
		expect(getStartScreen).not.toHaveBeenCalled()
	})

	it("redirects to /drive/$ with an empty splat when authed and the preference is drive", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)
		getStartScreen.mockResolvedValue("drive")

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string; params: { _splat: string } } }).options).toMatchObject({
			to: "/drive/$",
			params: { _splat: "" }
		})
	})

	it("redirects to /notes when authed and the preference is notes", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)
		getStartScreen.mockResolvedValue("notes")

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string } }).options).toMatchObject({ to: "/notes" })
	})

	it("redirects to /chats when authed and the preference is chats", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)
		getStartScreen.mockResolvedValue("chats")

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string } }).options).toMatchObject({ to: "/chats" })
	})

	it("redirects to /contacts with the default section filter when authed and the preference is contacts", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)
		getStartScreen.mockResolvedValue("contacts")

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string; search: { section: string } } }).options).toMatchObject({
			to: "/contacts",
			search: { section: "all" }
		})
	})

	it("falls back to the drive redirect when reading the preference rejects", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)
		getStartScreen.mockRejectedValue(new Error("kv boom"))

		const { resolveRootRedirect } = await freshModule()

		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string } }).options).toMatchObject({ to: "/drive/$" })
	})

	it("awaits boot readiness and hasClient() before ever reading the start-screen preference", async () => {
		const order: string[] = []
		whenBootReady.mockImplementation(() => {
			order.push("boot")
			return Promise.resolve()
		})
		hasClient.mockImplementation(() => {
			order.push("hasClient")
			return Promise.resolve(true)
		})
		getStartScreen.mockImplementation(() => {
			order.push("startScreen")
			return Promise.resolve("drive")
		})

		const { resolveRootRedirect } = await freshModule()
		await resolveRootRedirect().catch(() => undefined)

		expect(order).toEqual(["boot", "hasClient", "startScreen"])
	})
})

describe("deriveLegacyAppRedirect", () => {
	it("maps the pricing page's plan links, keeping a valid plan id", async () => {
		const { deriveLegacyAppRedirect } = await freshModule()

		expect(deriveLegacyAppRedirect("#/settings/plans?id=27")).toEqual({ kind: "plans", plan: 27 })
		expect(deriveLegacyAppRedirect("#/settings/plans")).toEqual({ kind: "plans" })
		expect(deriveLegacyAppRedirect("#/settings/plans?id=abc")).toEqual({ kind: "plans" })
		expect(deriveLegacyAppRedirect("#/settings/plans?id=-3")).toEqual({ kind: "plans" })
		expect(deriveLegacyAppRedirect("#/settings/plans?id=99999999999999999999")).toEqual({ kind: "plans" })
	})

	it("maps the sign-in hop with its plan, and registration", async () => {
		const { deriveLegacyAppRedirect } = await freshModule()

		expect(deriveLegacyAppRedirect("#/login?planId=30")).toEqual({ kind: "login", plan: 30 })
		expect(deriveLegacyAppRedirect("#/login")).toEqual({ kind: "login" })
		expect(deriveLegacyAppRedirect("#/register")).toEqual({ kind: "register" })
		expect(deriveLegacyAppRedirect("#/register?ref=abc")).toEqual({ kind: "register" })
	})

	it("ignores everything else", async () => {
		const { deriveLegacyAppRedirect } = await freshModule()

		expect(deriveLegacyAppRedirect("")).toBeNull()
		expect(deriveLegacyAppRedirect("#/drive")).toBeNull()
		expect(deriveLegacyAppRedirect("#/settings/plansx")).toBeNull()
	})
})

describe("resolveRootRedirect with a previous-app hash", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function withHash(hash: string): void {
		vi.stubGlobal("window", { location: { hash } })
	}

	async function options(): Promise<{ to: string; search?: unknown; replace?: boolean }> {
		const { resolveRootRedirect } = await freshModule()
		const rejection: unknown = await resolveRootRedirect().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)

		return (rejection as { options: { to: string; search?: unknown; replace?: boolean } }).options
	}

	it("opens the plans with the plan preselected when signed in", async () => {
		withHash("#/settings/plans?id=27")
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)

		expect(await options()).toMatchObject({ to: "/settings/plans", search: { plan: 27 }, replace: true })
		expect(getStartScreen).not.toHaveBeenCalled()
	})

	it("keeps the plan through sign-in when signed out", async () => {
		withHash("#/settings/plans?id=27")
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(false)

		expect(await options()).toMatchObject({ to: "/login", replace: true })
		expect(rememberPlansTarget).toHaveBeenCalledWith(27)
	})

	it("treats the old sign-in hop with a plan the same way", async () => {
		withHash("#/login?planId=30")
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)

		expect(await options()).toMatchObject({ to: "/settings/plans", search: { plan: 30 } })
	})

	it("lands a bare sign-in link normally", async () => {
		withHash("#/login")
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(false)

		expect(await options()).toMatchObject({ to: "/login" })
		expect(rememberPlansTarget).not.toHaveBeenCalled()
	})

	it("sends registration links to /register", async () => {
		withHash("#/register")

		expect(await options()).toMatchObject({ to: "/register", replace: true })
		expect(hasClient).not.toHaveBeenCalled()
	})
})
