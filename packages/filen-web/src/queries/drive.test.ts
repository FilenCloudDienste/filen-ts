import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, File, NormalDirsAndFiles, UuidStr } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it
// down to the two methods this module calls, mirroring account.test.ts's mock boundary.
const { listDirectory, resolveDirectoryNames } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	resolveDirectoryNames: vi.fn<(uuids: string[]) => Promise<Record<string, string>>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory, resolveDirectoryNames } }))

import { driveListingQueryKey, driveNamesQueryKey, fetchDirectoryListing, fetchDirectoryNames } from "@/queries/drive"

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

describe("driveNamesQueryKey", () => {
	it("builds the [domain, entity, uuids] tuple", () => {
		expect(driveNamesQueryKey(["a", "b"])).toEqual(["drive", "names", ["a", "b"]])
	})
})

describe("fetchDirectoryNames", () => {
	it("returns an empty record without calling the worker for an empty uuid list", async () => {
		const result = await fetchDirectoryNames([])

		expect(result).toEqual({})
		expect(resolveDirectoryNames).not.toHaveBeenCalled()
	})

	it("passes the uuids through to sdkApi.resolveDirectoryNames unchanged", async () => {
		resolveDirectoryNames.mockResolvedValueOnce({})

		await fetchDirectoryNames(["uuid-a", "uuid-b"])

		expect(resolveDirectoryNames).toHaveBeenCalledTimes(1)
		expect(resolveDirectoryNames).toHaveBeenCalledWith(["uuid-a", "uuid-b"])
	})

	it("returns the worker's resolved record unchanged, including a partial result", async () => {
		resolveDirectoryNames.mockResolvedValueOnce({ "uuid-a": "Documents" })

		const result = await fetchDirectoryNames(["uuid-a", "uuid-b"])

		expect(result).toEqual({ "uuid-a": "Documents" })
	})

	it("propagates a rejection from sdkApi.resolveDirectoryNames unchanged", async () => {
		const error = new Error("no authenticated client")
		resolveDirectoryNames.mockRejectedValueOnce(error)

		await expect(fetchDirectoryNames(["uuid-a"])).rejects.toBe(error)
	})
})
