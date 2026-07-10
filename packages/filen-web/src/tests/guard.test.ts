import { afterEach, describe, expect, it, vi } from "vitest"
import { isRedirect } from "@tanstack/react-router"

// redirectIfAuthed guards the unauthed-only pages (/login, /register, /reset/$token): a live
// session bounces straight to Drive instead of re-showing the auth form. Real `redirect`/`isRedirect`
// from the router are used un-mocked below — they're pure (construct + optionally throw a tagged
// Response), no router instance needed to exercise them.

const { hasClient, whenBootReady } = vi.hoisted(() => ({ hasClient: vi.fn(), whenBootReady: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient } }))
vi.mock("@/lib/sdk/boot", () => ({ whenBootReady }))

async function freshModule() {
	vi.resetModules()
	return import("@/features/auth/lib/guard")
}

afterEach(() => {
	vi.clearAllMocks()
})

describe("redirectIfAuthed", () => {
	it("resolves (no redirect) when there is no active client", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(false)

		const { redirectIfAuthed } = await freshModule()

		await expect(redirectIfAuthed()).resolves.toBeUndefined()
	})

	it("throws a redirect to /drive/$ with an empty splat when a session is live", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockResolvedValue(true)

		const { redirectIfAuthed } = await freshModule()

		const rejection: unknown = await redirectIfAuthed().catch((e: unknown) => e)

		expect(isRedirect(rejection)).toBe(true)
		expect((rejection as { options: { to: string; params: { _splat: string } } }).options).toMatchObject({
			to: "/drive/$",
			params: { _splat: "" }
		})
	})

	it("treats a hasClient rejection as unauthed (no redirect, no throw)", async () => {
		whenBootReady.mockResolvedValue(undefined)
		hasClient.mockRejectedValue(new Error("sdk boom"))

		const { redirectIfAuthed } = await freshModule()

		await expect(redirectIfAuthed()).resolves.toBeUndefined()
	})

	it("awaits boot readiness before ever reading hasClient()", async () => {
		const order: string[] = []
		whenBootReady.mockImplementation(() => {
			order.push("boot")
			return Promise.resolve()
		})
		hasClient.mockImplementation(() => {
			order.push("hasClient")
			return Promise.resolve(false)
		})

		const { redirectIfAuthed } = await freshModule()
		await redirectIfAuthed()

		expect(order).toEqual(["boot", "hasClient"])
	})

	it("propagates a whenBootReady rejection without ever reading hasClient()", async () => {
		whenBootReady.mockRejectedValue(new Error("boot failed"))

		const { redirectIfAuthed } = await freshModule()

		await expect(redirectIfAuthed()).rejects.toThrow("boot failed")
		expect(hasClient).not.toHaveBeenCalled()
	})
})
