import { describe, expect, it, vi } from "vitest"

// An unreadable desktop session keeps boot on the recovery screen: nothing is cleared, the guards go on as signed out,
// and only a retry that reads the session again (or finds it discarded) marks boot ready.
const session = vi.hoisted(() => {
	class SessionUnreadableError extends Error {}

	const state = { unreadable: true, calls: [] as string[] }

	return {
		state,
		SessionUnreadableError,
		clearSessionOutsideKv: vi.fn(() => Promise.resolve()),
		persistSession: vi.fn(),
		resumeSession: vi.fn(() => {
			state.calls.push("resume")

			return state.unreadable ? Promise.reject(new SessionUnreadableError()) : Promise.resolve(false)
		}),
		discardUnreadableSession: vi.fn(() => {
			state.calls.push("discard")
			state.unreadable = false

			return Promise.resolve()
		})
	}
})

const persist = vi.hoisted(() => ({ restorePersistedQueries: vi.fn(), purgePersistedQueries: vi.fn(() => Promise.resolve()) }))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot: () => Promise.resolve({ ok: true, threads: 2 }), setClientConfig: () => Promise.resolve() },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({ storage: () => Promise.resolve({}), kvGetJson: () => Promise.resolve(null) }))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable: () => true }))
vi.mock("@/lib/sdk/session", () => session)
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => persist)

import { bootSdk, retrySessionResume, whenBootReady } from "@/lib/sdk/boot"
import { useBootStore } from "@/stores/boot"

describe("boot with an unreadable desktop session", () => {
	it("waits on recovery, retries the read, and opens unauthed once the session is discarded", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })

		await bootSdk()

		expect(useBootStore.getState().phase).toBe("sessionUnreadable")
		expect(session.clearSessionOutsideKv).not.toHaveBeenCalled()
		expect(persist.purgePersistedQueries).not.toHaveBeenCalled()
		// Guards must not hang behind the screen.
		await expect(whenBootReady()).resolves.toBeUndefined()

		// Try again: still locked.
		await expect(retrySessionResume(false)).resolves.toBe(false)
		expect(session.state.calls).toEqual(["resume", "resume"])
		expect(useBootStore.getState().phase).toBe("sessionUnreadable")

		// Sign in again: discarded first, then the resume finds no session and boot is ready for sign-in.
		await expect(retrySessionResume(true)).resolves.toBe(true)
		expect(session.state.calls).toEqual(["resume", "resume", "discard", "resume"])
		expect(persist.purgePersistedQueries).toHaveBeenCalledTimes(1)
		expect(persist.restorePersistedQueries).not.toHaveBeenCalled()
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("keeps the screen when the discard fails", async () => {
		session.discardUnreadableSession.mockRejectedValueOnce(new Error("EACCES"))
		useBootStore.setState({ phase: "sessionUnreadable" })

		await expect(retrySessionResume(true)).rejects.toThrow("EACCES")
		expect(useBootStore.getState().phase).toBe("sessionUnreadable")
	})
})
