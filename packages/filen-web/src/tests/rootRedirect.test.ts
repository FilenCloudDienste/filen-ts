import { afterEach, describe, expect, it, vi } from "vitest"
import { isRedirect } from "@tanstack/react-router"

// resolveRootRedirect is the root route's (`/`) beforeLoad: it bounces an unauthed load to /login,
// and an authed load onward to whichever module the persisted start-screen preference names (see
// startScreen.test.ts for the preference's own get/set roundtrip — this covers the redirect switch
// itself, same split as guard.test.ts covers redirectIfAuthed). Real `redirect`/`isRedirect` from the
// router are used un-mocked below — they're pure (construct + optionally throw a tagged Response), no
// router instance needed to exercise them.

const { hasClient, whenBootReady, getStartScreen } = vi.hoisted(() => ({
	hasClient: vi.fn(),
	whenBootReady: vi.fn(),
	getStartScreen: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient } }))
vi.mock("@/lib/sdk/boot", () => ({ whenBootReady }))
vi.mock("@/features/shell/lib/startScreen", () => ({ getStartScreen }))

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
