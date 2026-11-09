import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/sdk/session", () => ({ readPersistedSession: vi.fn(), resumeSession: vi.fn() }))
vi.mock("@/features/shell/lib/performLogout", () => ({ performLogout: vi.fn() }))

import { createSessionEndedCheck, SESSION_RECHECK_MS, type SessionEndedDeps } from "@/features/shell/lib/sessionEnded"
import { noteSdkRejection, setSessionSuspectListener, watchSessionHealth, withSessionCheckHeld } from "@/lib/sdk/sessionHealth"
import { clearSessionEndedNote, readSessionEndedNote, writeSessionEndedNote } from "@/lib/sessionEndedNote"

const ENDED = { species: "sdk", kind: "Unauthenticated", label: "x", message: "x" }

function harness(overrides: Partial<SessionEndedDeps> = {}) {
	const deps = {
		isOnline: vi.fn(() => true),
		signOutPending: vi.fn(() => false),
		probe: vi.fn<() => Promise<boolean>>().mockRejectedValue(ENDED),
		liveApiKey: vi.fn(() => Promise.resolve<string | null>("key")),
		persistedApiKey: vi.fn(() => Promise.resolve<string | null>("key")),
		adoptPersisted: vi.fn(() => Promise.resolve(true)),
		wait: vi.fn(() => Promise.resolve()),
		signOut: vi.fn(() => Promise.resolve()),
		...overrides
	}

	return { deps, check: createSessionEndedCheck(deps) }
}

describe("createSessionEndedCheck", () => {
	it("signs out once the server refuses the session twice, a moment apart", async () => {
		const { deps, check } = harness()

		await check()

		expect(deps.probe).toHaveBeenCalledTimes(2)
		expect(deps.wait).toHaveBeenCalledWith(SESSION_RECHECK_MS)
		expect(deps.signOut).toHaveBeenCalledTimes(1)
	})

	it("signs out only once however many reports arrive", async () => {
		const { deps, check } = harness()

		await Promise.all([check(), check(), check()])
		await check()

		expect(deps.signOut).toHaveBeenCalledTimes(1)
	})

	it("never signs out while offline", async () => {
		const { deps, check } = harness({ isOnline: () => false })

		await check()

		expect(deps.probe).not.toHaveBeenCalled()
		expect(deps.signOut).not.toHaveBeenCalled()
	})

	it("stays signed in when the network went while it checked", async () => {
		const isOnline = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
		const { deps, check } = harness({ isOnline })

		await check()

		expect(deps.signOut).not.toHaveBeenCalled()
	})

	it("leaves it to another tab already signing out", async () => {
		const { deps, check } = harness({ signOutPending: () => true })

		await check()

		expect(deps.signOut).not.toHaveBeenCalled()
	})

	it("stays signed in when the session works, a transient refusal clears, or the failure is the network", async () => {
		for (const probe of [
			() => Promise.resolve(true),
			vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(ENDED).mockResolvedValue(true),
			vi.fn<() => Promise<boolean>>().mockRejectedValue({ ...ENDED, kind: "Reqwest" }),
			() => Promise.resolve(false)
		]) {
			const { deps, check } = harness({ probe })

			await check()

			expect(deps.signOut).not.toHaveBeenCalled()
		}
	})

	it("takes the session another tab saved after a password change instead of signing out", async () => {
		const probe = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(ENDED).mockResolvedValue(true)
		const { deps, check } = harness({ probe, persistedApiKey: () => Promise.resolve("new-key") })

		await check()

		expect(deps.adoptPersisted).toHaveBeenCalledTimes(1)
		expect(deps.signOut).not.toHaveBeenCalled()
	})

	it("signs out when the saved session is refused too", async () => {
		const { deps, check } = harness({ persistedApiKey: () => Promise.resolve("new-key") })

		await check()

		expect(deps.adoptPersisted).toHaveBeenCalled()
		expect(deps.signOut).toHaveBeenCalledTimes(1)
	})
})

describe("sessionHealth", () => {
	beforeEach(() => {
		setSessionSuspectListener(() => undefined)()
	})

	it("reports only Unauthenticated rejections", () => {
		const listener = vi.fn()
		const off = setSessionSuspectListener(listener)

		noteSdkRejection({ kind: "Reqwest" })
		noteSdkRejection(new Error("x"))
		noteSdkRejection(ENDED)

		expect(listener).toHaveBeenCalledTimes(1)
		off()
	})

	it("holds reports while a password change runs, then checks once", async () => {
		const listener = vi.fn()
		const off = setSessionSuspectListener(listener)
		let finish: () => void = () => undefined
		const held = withSessionCheckHeld(
			() =>
				new Promise<void>(resolve => {
					finish = resolve
				})
		)

		noteSdkRejection(ENDED)
		noteSdkRejection(ENDED)
		expect(listener).not.toHaveBeenCalled()

		finish()
		await held

		expect(listener).toHaveBeenCalledTimes(1)
		off()
	})

	it("sees every rejected worker call while the caller still gets the rejection", async () => {
		const listener = vi.fn()
		const off = setSessionSuspectListener(listener)
		const remote = watchSessionHealth({
			getUserInfo: vi.fn<() => Promise<never>>().mockRejectedValue(ENDED),
			hasClient: () => Promise.resolve(true)
		})

		await expect(remote.getUserInfo()).rejects.toBe(ENDED)
		await expect(remote.hasClient()).resolves.toBe(true)

		expect(listener).toHaveBeenCalledTimes(1)
		off()
	})
})

describe("sessionEndedNote", () => {
	beforeEach(() => {
		const store = new Map<string, string>()

		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key)
		})
	})

	it("shows on the sign-in screens for a while, until the next sign-in", () => {
		writeSessionEndedNote(1000)

		expect(readSessionEndedNote(1000)).toBe(true)
		expect(readSessionEndedNote(1000 + 60 * 60 * 1000)).toBe(false)

		clearSessionEndedNote()
		expect(readSessionEndedNote(1000)).toBe(false)
	})
})
