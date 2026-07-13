import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, NormalDirsAndFiles, UuidStr } from "@filen/sdk-rs"

const { listPhotosRecursive } = vi.hoisted(() => ({
	listPhotosRecursive: vi.fn<(rootUuid: string) => Promise<NormalDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listPhotosRecursive } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { fetchPhotosListing, photosListingQueryKey, photosListingQueryUpdate } from "@/features/photos/queries/photos"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"

function photoItem(overrides: Partial<File> = {}): PhotoItem {
	const item = narrowItem(mockFile(overrides))

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("root"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Sub" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		parent: testUuid("root"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "photo.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
}

beforeEach(() => {
	testQueryClient.clear()
	vi.clearAllMocks()
})

describe("photosListingQueryKey", () => {
	it("scopes the key under the photos domain, keyed by rootUuid", () => {
		expect(photosListingQueryKey("root-uuid")).toEqual(["photos", "listing", "root-uuid"])
	})
})

describe("fetchPhotosListing", () => {
	it("calls listPhotosRecursive with the given root uuid", async () => {
		listPhotosRecursive.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchPhotosListing("root-uuid")

		expect(listPhotosRecursive).toHaveBeenCalledWith("root-uuid")
	})

	it("filters non-media files and directories out of the recursive walk's flat result", async () => {
		listPhotosRecursive.mockResolvedValueOnce({
			dirs: [mockDir()],
			files: [
				mockFile({
					uuid: testUuid("photo"),
					meta: { type: "decoded", data: { name: "beach.jpg", mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
				}),
				mockFile({
					uuid: testUuid("doc"),
					meta: {
						type: "decoded",
						data: { name: "report.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
					}
				})
			]
		})

		const result = await fetchPhotosListing("root-uuid")

		expect(result).toHaveLength(1)
		expect(result[0]?.data.uuid).toBe(testUuid("photo"))
	})

	it("sorts the filtered set capture-descending (a buried-deep photo isn't just included, it's sorted alongside the rest)", async () => {
		listPhotosRecursive.mockResolvedValueOnce({
			dirs: [],
			files: [mockFile({ uuid: testUuid("older"), timestamp: 1_000n }), mockFile({ uuid: testUuid("newer"), timestamp: 2_000n })]
		})

		const result = await fetchPhotosListing("root-uuid")

		expect(result.map(item => item.data.uuid)).toEqual([testUuid("newer"), testUuid("older")])
	})

	it("propagates a rejection unchanged (a gone root's error reaches the caller intact)", async () => {
		const error = new Error("directory not found: root-uuid")
		listPhotosRecursive.mockRejectedValueOnce(error)

		await expect(fetchPhotosListing("root-uuid")).rejects.toBe(error)
	})
})

function seedListing(rootUuid: string, items: PhotoItem[]): void {
	testQueryClient.setQueryData(photosListingQueryKey(rootUuid), items)
}

function getListing(rootUuid: string): PhotoItem[] | undefined {
	return testQueryClient.getQueryData<PhotoItem[]>(photosListingQueryKey(rootUuid))
}

describe("photosListingQueryUpdate", () => {
	it("patches the exact ['photos','listing',rootUuid] key", () => {
		const rootUuid = "root-a"
		seedListing(rootUuid, [])

		photosListingQueryUpdate(rootUuid, prev => [...prev, photoItem()])

		expect(getListing(rootUuid)).toHaveLength(1)
	})

	it("leaves a NOT-yet-fetched root's cache alone (undefined stays undefined, never conjures a [])", () => {
		photosListingQueryUpdate("never-fetched-root", prev => [...prev])

		expect(getListing("never-fetched-root")).toBeUndefined()
	})

	it("never touches a DIFFERENT root's cached listing", () => {
		seedListing("root-a", [])
		seedListing("root-b", [])

		photosListingQueryUpdate("root-a", prev => [...prev, photoItem()])

		expect(getListing("root-a")).toHaveLength(1)
		expect(getListing("root-b")).toHaveLength(0)
	})
})
