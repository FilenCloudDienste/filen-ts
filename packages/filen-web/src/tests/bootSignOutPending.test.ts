import { beforeEach, describe, expect, it, vi } from "vitest"

// A sign-out cut short leaves its flag set; the next boot redoes every wipe before any session resume,
// and keeps the flag for another try while a wipe still fails.
const { calls, kvClear, wipeThumbnailStore, wipeSwClient } = vi.hoisted(() => {
	const calls: string[] = []

	return {
		calls,
		kvClear: vi.fn(() => {
			calls.push("kvClear")

			return Promise.resolve()
		}),
		wipeThumbnailStore: vi.fn(() => {
			calls.push("wipeThumbnails")

			return Promise.resolve()
		}),
		wipeSwClient: vi.fn(() => {
			calls.push("wipeServiceWorker")

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot: () => Promise.resolve({ ok: true, threads: 2 }), setClientConfig: () => Promise.resolve() },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({ storage: () => Promise.resolve({}), kvGetJson: () => Promise.resolve(null), kvClear }))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable: () => true }))
vi.mock("@/lib/sdk/session", () => ({
	persistSession: vi.fn(),
	resumeSession: () => {
		calls.push("resumeSession")

		return Promise.resolve(false)
	}
}))
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => ({ restorePersistedQueries: vi.fn(), purgePersistedQueries: () => Promise.resolve() }))
vi.mock("@/features/drive/lib/thumbCache", () => ({ wipeThumbnailStore }))
vi.mock("@/features/drive/lib/saveDownload", () => ({ wipeSwClient }))

import { bootSdk } from "@/lib/sdk/boot"
import { readSignOutPending, writeSignOutPending } from "@/lib/signOutPending"
import { useBootStore } from "@/stores/boot"

beforeEach(() => {
	const store = new Map<string, string>()

	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key)
	})
	calls.length = 0
	vi.clearAllMocks()
	useBootStore.setState({ phase: "idle" })
})

describe("bootSdk after a sign-out cut short", () => {
	it("redoes every wipe before resuming a session, then clears the flag", async () => {
		writeSignOutPending(true)

		await bootSdk()

		expect(calls.slice(0, 3).sort()).toEqual(["kvClear", "wipeServiceWorker", "wipeThumbnails"])
		expect(calls[3]).toBe("resumeSession")
		expect(readSignOutPending()).toBe(false)
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("keeps the flag for the next boot while a wipe still fails", async () => {
		writeSignOutPending(true)
		wipeThumbnailStore.mockRejectedValueOnce(new Error("entry locked"))

		await bootSdk()

		expect(readSignOutPending()).toBe(true)
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("wipes nothing when no sign-out is pending", async () => {
		await bootSdk()

		expect(calls).toEqual(["resumeSession"])
	})
})
