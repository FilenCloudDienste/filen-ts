import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LockId } from "@filen/sdk-rs"

// Boot releases the locks the page before it still owed, before the first write (setReady), bounded.
const { calls, releaseLocks, resumed } = vi.hoisted(() => {
	const calls: string[] = []

	return {
		calls,
		resumed: { value: true },
		releaseLocks: vi.fn((locks: LockId[]) => {
			calls.push(`release:${String(locks.length)}`)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot: () => Promise.resolve({ ok: true, threads: 2 }), setClientConfig: () => Promise.resolve(), releaseLocks },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({ storage: () => Promise.resolve({}), kvGetJson: () => Promise.resolve(null) }))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable: () => true }))
vi.mock("@/lib/sdk/session", () => ({
	clearSessionOutsideKv: () => Promise.resolve(),
	persistSession: vi.fn(),
	resumeSession: () => {
		calls.push("resume")

		return Promise.resolve(resumed.value)
	}
}))
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => ({ restorePersistedQueries: () => Promise.resolve(), purgePersistedQueries: () => Promise.resolve() }))
vi.mock("@/queries/driveRoot", () => ({ warmDriveRootUuid: () => Promise.resolve() }))

import { bootSdk } from "@/lib/sdk/boot"
import { onLockEvent, owedLocks, OWED_LOCKS_KEY, OWED_LOCKS_RELEASE_TIMEOUT_MS } from "@/lib/sdk/owedLocks"
import { useBootStore } from "@/stores/boot"

const LOCK: LockId = { uuid: "00000001-0000-4000-8000-000000000000", resource: "notes" }
const session = new Map<string, string>()

useBootStore.subscribe(state => {
	if (state.phase === "ready") {
		calls.push("ready")
	}
})

beforeEach(() => {
	session.clear()
	calls.length = 0
	resumed.value = true
	releaseLocks.mockClear()
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => session.get(key) ?? null,
		setItem: (key: string, value: string) => session.set(key, value),
		removeItem: (key: string) => session.delete(key)
	})
	useBootStore.setState({ phase: "idle" })
})

afterEach(() => {
	for (const held of [...owedLocks().values()]) {
		onLockEvent({ kind: "settled", lock: held })
	}
	vi.useRealTimers()
})

describe("boot with locks the page before owed", () => {
	it("reads, removes and releases them after the resume and before the first write", async () => {
		session.set(OWED_LOCKS_KEY, JSON.stringify([LOCK]))

		await bootSdk()

		expect(releaseLocks).toHaveBeenCalledWith([LOCK])
		expect(calls).toEqual(["resume", "release:1", "ready"])
		expect(session.has(OWED_LOCKS_KEY)).toBe(false)
	})

	it("releases nothing when none were handed on", async () => {
		await bootSdk()

		expect(releaseLocks).not.toHaveBeenCalled()
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("consumes the key without releasing on an unauthed boot", async () => {
		resumed.value = false
		session.set(OWED_LOCKS_KEY, JSON.stringify([LOCK]))

		await bootSdk()

		expect(releaseLocks).not.toHaveBeenCalled()
		expect(session.has(OWED_LOCKS_KEY)).toBe(false)
	})

	it("goes on to ready when the release does not answer in time", async () => {
		vi.useFakeTimers()
		releaseLocks.mockImplementationOnce(() => new Promise<void>(() => undefined))
		session.set(OWED_LOCKS_KEY, JSON.stringify([LOCK]))

		const booted = bootSdk()
		await vi.advanceTimersByTimeAsync(OWED_LOCKS_RELEASE_TIMEOUT_MS)
		await booted

		expect(useBootStore.getState().phase).toBe("ready")
		// Still owed, so a reload now hands it on again.
		expect([...owedLocks().values()]).toEqual([LOCK])
	})
})
