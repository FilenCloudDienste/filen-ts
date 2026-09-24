// markDirectorySizesStale runs for every size-changing drive event and every local write, so a burst (a remote
// mass delete, a bulk action and its echoes) must not scan the whole query cache once per call. The size and
// account queries it marks must still read again on their next mount.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"

const holder = vi.hoisted(() => ({ client: null as unknown as import("@tanstack/react-query").QueryClient }))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	sortParams: (await import("@filen/shared")).sortParams
}))
vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	get queryClient() {
		return holder.client
	},
	queryUpdater: { set: vi.fn() }
}))
vi.mock("@/lib/cache", () => ({ default: {} }))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: vi.fn() } }))
vi.mock("@/features/offline/offline", () => ({ default: {} }))
vi.mock("@/features/drive/driveSelectors", () => ({ isDirectoryItem: () => true }))
vi.mock("@filen/sdk-rs", () => ({}))

import { markDirectorySizesStale, directorySizeQueryOptions } from "@/features/drive/queries/useDirectorySize.query"
import { markAccountStale, BASE_QUERY_KEY as ACCOUNT_KEY } from "@/queries/useAccount.query"

function sizeKey(uuid: string): unknown[] {
	return directorySizeQueryOptions({ uuid, type: "normal" }).queryKey
}

function sizeIsInvalidated(uuid: string): boolean | undefined {
	return holder.client.getQueryState(sizeKey(uuid))?.isInvalidated
}

function accountIsInvalidated(): boolean | undefined {
	return holder.client.getQueryState([ACCOUNT_KEY])?.isInvalidated
}

function seed(): void {
	// Listings, thumbnails and the like: everything a real cache holds besides sizes.
	for (let i = 0; i < 2000; i++) {
		holder.client.setQueryData(["unrelated", { i }], i)
	}

	for (const uuid of ["d1", "d2", "d3"]) {
		holder.client.setQueryData(sizeKey(uuid), { size: 1, files: 1, dirs: 0 })
	}

	holder.client.setQueryData([ACCOUNT_KEY], { storageUsed: 1n })
}

beforeEach(() => {
	holder.client = new QueryClient()
	seed()
})

describe("markDirectorySizesStale", () => {
	it("scans the cache once for a burst, and leaves every size and the account to be read again", () => {
		const findAll = vi.spyOn(holder.client.getQueryCache(), "findAll")

		for (let i = 0; i < 200; i++) {
			markDirectorySizesStale()
		}

		expect(findAll).toHaveBeenCalledTimes(1)
		expect(["d1", "d2", "d3"].map(sizeIsInvalidated)).toEqual([true, true, true])
		expect(accountIsInvalidated()).toBe(true)
	})

	it("marks a size read again after a mark, and one first cached after it", () => {
		markDirectorySizesStale()

		const findAll = vi.spyOn(holder.client.getQueryCache(), "findAll")

		holder.client.setQueryData(sizeKey("d2"), { size: 2, files: 1, dirs: 0 })
		holder.client.setQueryData(sizeKey("new"), { size: 3, files: 1, dirs: 0 })

		expect([sizeIsInvalidated("d2"), sizeIsInvalidated("new")]).toEqual([false, false])

		markDirectorySizesStale()
		markDirectorySizesStale()

		expect([sizeIsInvalidated("d2"), sizeIsInvalidated("new")]).toEqual([true, true])
		expect(findAll).toHaveBeenCalledTimes(1)
	})

	it("an unrelated query updating doesn't bring the scan back", () => {
		markDirectorySizesStale()

		const findAll = vi.spyOn(holder.client.getQueryCache(), "findAll")

		holder.client.setQueryData(["unrelated", { i: 1 }], 42)
		markDirectorySizesStale()

		expect(findAll).not.toHaveBeenCalled()
	})
})

describe("markAccountStale", () => {
	it("marks the account without scanning the cache, and only once", () => {
		const findAll = vi.spyOn(holder.client.getQueryCache(), "findAll")
		const updates = vi.fn()

		holder.client.getQueryCache().subscribe(event => {
			if (event.type === "updated" && event.query.queryKey[0] === ACCOUNT_KEY) {
				updates(event.action.type)
			}
		})

		markAccountStale()
		markAccountStale()

		expect(accountIsInvalidated()).toBe(true)
		expect(findAll).not.toHaveBeenCalled()
		expect(updates.mock.calls).toEqual([["invalidate"]])
	})

	it("does nothing before the account was ever read", () => {
		holder.client.removeQueries({ queryKey: [ACCOUNT_KEY] })

		markAccountStale()

		expect(holder.client.getQueryState([ACCOUNT_KEY])).toBeUndefined()
	})
})
