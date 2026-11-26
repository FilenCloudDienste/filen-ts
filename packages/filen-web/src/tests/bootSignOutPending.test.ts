import { beforeEach, describe, expect, it, vi } from "vitest"

// A sign-out cut short leaves its flag set; the next boot redoes every wipe before any session resume,
// and keeps the flag for another try while a wipe still fails.
const {
	calls,
	kv,
	kvClear,
	clearSessionOutsideKv,
	wipeThumbnailStore,
	wipeLinkThumbnailStore,
	wipeArtStore,
	wipeVideoIndexStore,
	wipeSwClient,
	wipeLegacyWebOnSignOut
} = vi.hoisted(() => {
	const calls: string[] = []
	const kv = new Map<string, unknown>()

	return {
		calls,
		kv,
		kvClear: vi.fn(() => {
			calls.push("kvClear")
			kv.clear()

			return Promise.resolve()
		}),
		clearSessionOutsideKv: vi.fn(() => {
			calls.push("clearSession")

			return Promise.resolve()
		}),
		wipeThumbnailStore: vi.fn(() => {
			calls.push("wipeThumbnails")

			return Promise.resolve()
		}),
		wipeLinkThumbnailStore: vi.fn(() => {
			calls.push("wipeLinkThumbnails")

			return Promise.resolve()
		}),
		wipeArtStore: vi.fn(() => {
			calls.push("wipeArt")

			return Promise.resolve()
		}),
		wipeVideoIndexStore: vi.fn(() => {
			calls.push("wipeVideoIndex")

			return Promise.resolve()
		}),
		wipeSwClient: vi.fn(() => {
			calls.push("wipeServiceWorker")

			return Promise.resolve()
		}),
		wipeLegacyWebOnSignOut: vi.fn(() => {
			calls.push("wipeLegacy")

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot: () => Promise.resolve({ ok: true, threads: 2 }), setClientConfig: () => Promise.resolve() },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({
	storage: () => Promise.resolve({}),
	kvGetJson: (key: string) => Promise.resolve(kv.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kv.set(key, value)

		return Promise.resolve()
	},
	kvEntriesJson: () => Promise.resolve([]),
	kvClear
}))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable: () => true }))
// The real persistSession: a sign-in after a boot that opened signed out finishes the sign-out first.
vi.mock("@/lib/sdk/session", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/sdk/session")>()),
	clearSessionOutsideKv,
	resumeSession: () => {
		calls.push("resumeSession")

		return Promise.resolve(false)
	}
}))
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => ({ restorePersistedQueries: vi.fn(), purgePersistedQueries: () => Promise.resolve() }))
vi.mock("@/features/drive/lib/thumbCache", () => ({ wipeThumbnailStore }))
vi.mock("@/features/publicLinks/lib/thumbCache", () => ({ wipeLinkThumbnailStore }))
vi.mock("@/features/videos/lib/artStore", () => ({ wipeArtStore }))
vi.mock("@/features/videos/lib/indexStore", () => ({ wipeVideoIndexStore }))
vi.mock("@/features/drive/lib/saveDownload", () => ({ wipeSwClient }))
vi.mock("@/lib/legacyWebMigration", () => ({ wipeLegacyWebOnSignOut, runLegacyWebMigration: () => Promise.resolve(false) }))

import type { StringifiedClient } from "@filen/sdk-rs"
import { bootSdk } from "@/lib/sdk/boot"
import { persistSession } from "@/lib/sdk/session"
import { readSignOutPending, writeSignOutPending } from "@/lib/signOutPending"
import { useBootStore } from "@/stores/boot"
import { useDirectoryTreeStore } from "@/features/drive/store/useDirectoryTreeStore"

// kvClear itself, not keepKeymapsAcrossWipe around it, which reads kvEntriesJson first.
const WIPES = [
	{ call: "kvClear", mock: kvClear },
	{ call: "clearSession", mock: clearSessionOutsideKv },
	{ call: "wipeThumbnails", mock: wipeThumbnailStore },
	{ call: "wipeLinkThumbnails", mock: wipeLinkThumbnailStore },
	{ call: "wipeArt", mock: wipeArtStore },
	{ call: "wipeVideoIndex", mock: wipeVideoIndexStore },
	{ call: "wipeServiceWorker", mock: wipeSwClient },
	{ call: "wipeLegacy", mock: wipeLegacyWebOnSignOut }
]

beforeEach(() => {
	const store = new Map<string, string>()

	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key)
	})
	calls.length = 0
	kv.clear()
	vi.clearAllMocks()
	useBootStore.setState({ phase: "idle" })
})

describe("bootSdk after a sign-out cut short", () => {
	it("redoes every wipe before resuming a session, then clears the flag", async () => {
		writeSignOutPending(true)

		await bootSdk()

		const resumedAt = calls.indexOf("resumeSession")

		expect(resumedAt).toBeGreaterThan(-1)

		for (const wipe of WIPES) {
			const at = calls.indexOf(wipe.call)

			expect(at, wipe.call).toBeGreaterThan(-1)
			expect(at, wipe.call).toBeLessThan(resumedAt)
		}

		expect(readSignOutPending()).toBe(false)
		expect(useBootStore.getState().phase).toBe("ready")
	})

	// A failed wipe may have left the session it was meant to remove: the boot opens signed out without reading it.
	it.each(WIPES)("keeps the flag and opens signed out while $call still fails", async ({ mock }) => {
		writeSignOutPending(true)
		mock.mockRejectedValueOnce(new Error("storage busy"))

		await bootSdk()

		expect(calls).not.toContain("resumeSession")
		expect(readSignOutPending()).toBe(true)
		expect(useBootStore.getState().phase).toBe("ready")
	})

	// The sign-in after it navigates without a reload: the signed-out account's tree map must not be in memory.
	it("does not load the tree map a failed wipe left", async () => {
		writeSignOutPending(true)
		kv.set("drive.treeOpen.v1", { "dir-a": "root" })
		useDirectoryTreeStore.setState({ open: {} })
		kvClear.mockRejectedValueOnce(new Error("storage busy"))

		await bootSdk()

		expect(kv.has("drive.treeOpen.v1")).toBe(true)
		expect(useDirectoryTreeStore.getState().open).toEqual({})
	})

	it("loads the tree map when no sign-out is pending", async () => {
		kv.set("drive.treeOpen.v1", { "dir-a": "root" })
		useDirectoryTreeStore.setState({ open: {} })

		await bootSdk()

		expect(useDirectoryTreeStore.getState().open).toEqual({ "dir-a": "root" })
	})

	// Without the sign-in finishing the sign-out, the next boot would wipe the new session or open signed out again.
	it.each([
		{ name: "the wipes succeed by then", failures: 1 },
		{ name: "a wipe still fails", failures: 2 }
	])("a sign-in after that survives the next boot when $name", async ({ failures }) => {
		writeSignOutPending(true)

		for (let i = 0; i < failures; i++) {
			kvClear.mockRejectedValueOnce(new Error("storage busy"))
		}

		await bootSdk()

		expect(calls).not.toContain("resumeSession")

		const session = { userId: 1n } as unknown as StringifiedClient

		await persistSession(session)

		expect(readSignOutPending()).toBe(false)
		expect(kv.get("sdk.session.v1")).toBe(session)

		calls.length = 0
		useBootStore.setState({ phase: "idle" })

		await bootSdk()

		expect(calls).toEqual(["resumeSession"])
		expect(kv.get("sdk.session.v1")).toBe(session)
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("wipes nothing when no sign-out is pending", async () => {
		await bootSdk()

		expect(calls).toEqual(["resumeSession"])
	})
})
