import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, File, NormalDirsAndFiles, GetItemPathResult, UuidStr } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it
// down to the two methods this module calls, mirroring account.test.ts's mock boundary.
const { listDirectory, getDirectoryPath } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	getDirectoryPath: vi.fn<(uuid: string) => Promise<GetItemPathResult & { current: Dir }>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory, getDirectoryPath } }))

import { driveListingQueryKey, fetchDirectoryListing, fetchDirectoryPath } from "@/queries/drive"

// Unlike account.test.ts (one call-count assertion in the whole file), several tests here assert
// exact call counts — clear history between tests so an earlier test's calls can't leak in.
beforeEach(() => {
	vi.clearAllMocks()
})

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring sort.test.ts's own uuid fixtures.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

describe("driveListingQueryKey", () => {
	it("builds the [domain, entity, params] tuple", () => {
		expect(driveListingQueryKey({ variant: "drive", uuid: "abc" })).toEqual(["drive", "listing", { variant: "drive", uuid: "abc" }])
	})
})

describe("fetchDirectoryListing", () => {
	it("targets root for the drive variant with a null uuid", async () => {
		listDirectory.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchDirectoryListing("drive", null)

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: "root" })
	})

	it("targets the given uuid for the drive variant with a non-null uuid", async () => {
		listDirectory.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchDirectoryListing("drive", "some-uuid")

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: "uuid", uuid: "some-uuid" })
	})

	it.each(["recents", "favorites", "trash"] as const)("targets the flat %s listing regardless of uuid", async variant => {
		listDirectory.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchDirectoryListing(variant, "some-uuid")

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: variant })
	})

	it("narrows dirs before files, preserving each group's own order", async () => {
		const dirAUuid = testUuid("dir-a")
		const dirBUuid = testUuid("dir-b")
		const fileAUuid = testUuid("file-a")
		const dirA = mockDir({ uuid: dirAUuid })
		const dirB = mockDir({ uuid: dirBUuid })
		const fileA = mockFile({ uuid: fileAUuid })
		listDirectory.mockResolvedValueOnce({ dirs: [dirA, dirB], files: [fileA] })

		const items = await fetchDirectoryListing("drive", null)

		expect(items.map(item => item.data.uuid)).toEqual([dirAUuid, dirBUuid, fileAUuid])
		expect(items.map(item => item.type)).toEqual(["directory", "directory", "file"])
	})

	it("propagates a rejection from sdkApi.listDirectory unchanged", async () => {
		const error = new Error("boom")
		listDirectory.mockRejectedValueOnce(error)

		await expect(fetchDirectoryListing("drive", null)).rejects.toBe(error)
	})
})

describe("fetchDirectoryPath", () => {
	it("narrows ancestors and the current directory, preserving path verbatim", async () => {
		const ancestorUuid = testUuid("ancestor-1")
		const currentUuid = testUuid("current-1")
		const ancestor = mockDir({ uuid: ancestorUuid })
		const current = mockDir({ uuid: currentUuid })
		getDirectoryPath.mockResolvedValueOnce({ path: "/Documents/Reports", ancestors: [ancestor], current })

		const result = await fetchDirectoryPath(currentUuid)

		expect(result.path).toBe("/Documents/Reports")
		expect(result.ancestors).toHaveLength(1)
		expect(result.ancestors[0]?.data.uuid).toBe(ancestorUuid)
		expect(result.current.data.uuid).toBe(currentUuid)
		expect(result.current.type).toBe("directory")
	})

	it("passes the uuid through to sdkApi.getDirectoryPath unchanged", async () => {
		getDirectoryPath.mockResolvedValueOnce({ path: "/Documents", ancestors: [], current: mockDir() })

		await fetchDirectoryPath("target-uuid")

		expect(getDirectoryPath).toHaveBeenCalledTimes(1)
		expect(getDirectoryPath).toHaveBeenCalledWith("target-uuid")
	})

	it("propagates a rejection from sdkApi.getDirectoryPath unchanged (e.g. not-found or undecryptable-ancestor DTOs)", async () => {
		const error = new Error("directory not found: missing-uuid")
		getDirectoryPath.mockRejectedValueOnce(error)

		await expect(fetchDirectoryPath("missing-uuid")).rejects.toBe(error)
	})
})
