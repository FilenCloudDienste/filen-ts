// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Query } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import { testUuid } from "@/tests/support/uuid"

// A save's listing patch reaches disk: the persister writes a row only after a read, so without this a reload
// restores the listing as last read, naming the version the save replaced, and a click before its first read
// lands opens that version. Serializing a listing blocks the main thread, so a patched listing is written once
// its patches pause, one listing per task, at once when the page is hidden or left, and never once a sign-out
// started.

const hooks = vi.hoisted(() => ({ persisted: [] as Query[], signOut: false, write: Promise.resolve() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({
	persister: {
		persistQuery: (query: Query) => {
			hooks.persisted.push(query)

			return hooks.write
		}
	}
}))
vi.mock("@/lib/signOutPending", () => ({ readSignOutPending: () => hooks.signOut }))

const { queryClient } = await import("@/queries/client")
const { driveListingQueryKey, driveListingQueryUpdate, patchedListingsWritten } = await import("@/features/drive/queries/drive")
const { runPreviewSave } = await import("@/features/drive/lib/previewSave.logic")
const { narrowItem } = await import("@/features/drive/lib/item")

type DriveItem = ReturnType<typeof narrowItem>

function file(label: string, name = "budget.xlsx"): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: "lineage" as File["stableUUID"],
		parent: testUuid("parent"),
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "", modified: 0n, size: 1n, key: "k", version: 2 } }
	})
}

const KEY = driveListingQueryKey({ variant: "drive", uuid: testUuid("parent") })
const OTHER_KEY = driveListingQueryKey({ variant: "drive", uuid: testUuid("other parent") })

async function save(from: DriveItem, to: DriveItem): Promise<void> {
	const outcome = await runPreviewSave(
		{
			uploadFileBytes: () => Promise.resolve(to.data as File),
			patchListing: driveListingQueryUpdate,
			rootUuid: testUuid("root")
		},
		{ item: from, content: new Uint8Array([1]) }
	)

	expect(outcome.status).toBe("success")
}

function uuidsOf(query: Query | undefined): string[] {
	return ((query?.state.data ?? []) as DriveItem[]).map(item => item.data.uuid)
}

function setVisibility(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
	document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
	vi.useFakeTimers()
	hooks.persisted = []
	hooks.signOut = false
	hooks.write = Promise.resolve()
	queryClient.clear()
	queryClient.setQueryData(KEY, [file("v0"), file("other", "notes.txt")])
})

afterEach(() => {
	vi.useRealTimers()
})

describe("a drive listing patched after a save", () => {
	it("is written to disk naming the saved version, once for every patch before the pause", async () => {
		await save(file("v0"), file("v1"))
		await save(file("v1"), file("v2"))
		expect(hooks.persisted).toEqual([])

		await vi.advanceTimersByTimeAsync(3_000)

		expect(hooks.persisted).toHaveLength(1)
		expect(uuidsOf(hooks.persisted[0])).toEqual(expect.arrayContaining([testUuid("v2"), testUuid("other")]))
		expect(uuidsOf(hooks.persisted[0])).not.toContain(testUuid("v0"))
		expect(uuidsOf(hooks.persisted[0])).not.toContain(testUuid("v1"))
	})

	it("is not written while patches keep coming, and once when they pause", async () => {
		let version = 0

		// A bulk action or a socket burst: a patch every 250 ms for 10 s.
		for (let i = 0; i < 40; i++) {
			await save(file(`v${String(version)}`), file(`v${String(version + 1)}`))
			version++
			await vi.advanceTimersByTimeAsync(250)
		}

		expect(hooks.persisted).toEqual([])

		await vi.advanceTimersByTimeAsync(3_000)

		expect(hooks.persisted).toHaveLength(1)
		expect(uuidsOf(hooks.persisted[0])).toContain(testUuid(`v${String(version)}`))
	})

	it("writes one listing per task", async () => {
		queryClient.setQueryData(OTHER_KEY, [file("w0")])
		await save(file("v0"), file("v1"))
		driveListingQueryUpdate(testUuid("other parent"), { type: "replace", uuid: testUuid("w0"), replace: () => file("w1") })

		await vi.advanceTimersByTimeAsync(2_000)
		expect(hooks.persisted).toHaveLength(1)

		await vi.advanceTimersToNextTimerAsync()
		expect(hooks.persisted).toHaveLength(2)
		expect(hooks.persisted.map(query => query.queryKey)).toEqual(expect.arrayContaining([KEY, OTHER_KEY]))
	})

	it("is written at once when the page is hidden or left", async () => {
		await save(file("v0"), file("v1"))
		setVisibility("hidden")
		expect(hooks.persisted).toHaveLength(1)
		setVisibility("visible")

		await save(file("v1"), file("v2"))
		window.dispatchEvent(new Event("pagehide"))
		expect(hooks.persisted).toHaveLength(2)
		expect(uuidsOf(hooks.persisted[1])).toContain(testUuid("v2"))

		// Nothing left for the pause.
		await vi.advanceTimersByTimeAsync(3_000)
		expect(hooks.persisted).toHaveLength(2)
	})

	it("is left to a read under way, which writes it, and written if that read fails", async () => {
		const read = Promise.withResolvers<DriveItem[]>()
		const fetching = queryClient.query({ queryKey: KEY, queryFn: () => read.promise })

		await save(file("v0"), file("v1"))
		await vi.advanceTimersByTimeAsync(5_000)
		expect(hooks.persisted).toEqual([])

		read.resolve([file("v1"), file("other", "notes.txt")])
		await fetching
		await vi.advanceTimersByTimeAsync(5_000)
		expect(hooks.persisted).toEqual([])

		const failing = Promise.withResolvers<DriveItem[]>()
		const refetching = queryClient.query({ queryKey: KEY, queryFn: () => failing.promise, staleTime: 0 })

		await save(file("v1"), file("v2"))
		await vi.advanceTimersByTimeAsync(5_000)
		expect(hooks.persisted).toEqual([])

		failing.reject(new Error("offline"))
		await expect(refetching).rejects.toThrow("offline")
		await vi.advanceTimersByTimeAsync(3_000)
		expect(hooks.persisted).toHaveLength(1)
		expect(uuidsOf(hooks.persisted[0])).toContain(testUuid("v2"))
	})

	it("is not written once a sign-out started, nor once the listing was dropped", async () => {
		await save(file("v0"), file("v1"))
		hooks.signOut = true
		await vi.advanceTimersByTimeAsync(3_000)
		expect(hooks.persisted).toEqual([])

		await save(file("v1"), file("v2"))
		setVisibility("hidden")
		window.dispatchEvent(new Event("pagehide"))
		expect(hooks.persisted).toEqual([])
		setVisibility("visible")

		hooks.signOut = false
		await save(file("v2"), file("v3"))
		queryClient.removeQueries({ queryKey: KEY })
		await vi.advanceTimersByTimeAsync(3_000)
		setVisibility("hidden")
		expect(hooks.persisted).toEqual([])
		setVisibility("visible")
	})

	it("is reported written only once its write is answered, so a reload restores it", async () => {
		const write = Promise.withResolvers<undefined>()

		hooks.write = write.promise
		expect(patchedListingsWritten()).toBe(true)

		await save(file("v0"), file("v1"))
		expect(patchedListingsWritten()).toBe(false)

		await vi.advanceTimersByTimeAsync(3_000)
		expect(hooks.persisted).toHaveLength(1)
		expect(patchedListingsWritten()).toBe(false)

		write.resolve(undefined)
		await vi.advanceTimersByTimeAsync(0)
		expect(patchedListingsWritten()).toBe(true)

		// The page left before the pause: the write it starts counts too.
		const left = Promise.withResolvers<undefined>()

		hooks.write = left.promise
		await save(file("v1"), file("v2"))
		window.dispatchEvent(new Event("pagehide"))
		expect(hooks.persisted).toHaveLength(2)
		expect(patchedListingsWritten()).toBe(false)

		left.resolve(undefined)
		await vi.advanceTimersByTimeAsync(0)
		expect(patchedListingsWritten()).toBe(true)
	})
})
