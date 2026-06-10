import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		instanceOf: vi.fn(() => false)
	},
	NonRootItem_Tags: {
		NormalDir: "NormalDir",
		File: "File",
		SharedDir: "SharedDir",
		SharedFile: "SharedFile"
	}
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapDirMeta: vi.fn((dir: unknown) => dir),
	unwrapFileMeta: vi.fn((file: unknown) => file),
	unwrapParentUuid: vi.fn(() => null),
	unwrappedDirIntoDriveItem: vi.fn((dir: unknown) => ({
		type: "directory",
		data: dir
	})),
	unwrappedFileIntoDriveItem: vi.fn((file: unknown) => ({
		type: "file",
		data: file
	}))
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdateForNormalParent: vi.fn()
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnyNormalDir: new Map()
	}
}))

import auth from "@/lib/auth"
import { findItemMatchesForName } from "@/features/drive/driveDirectory"

function mockSearchResults(results: { item: unknown; path: string }[]): ReturnType<typeof vi.fn> {
	const findItemMatchesForNameMock = vi.fn().mockResolvedValue(results)

	vi.mocked(auth.getSdkClients).mockResolvedValue({
		authedSdkClient: {
			findItemMatchesForName: findItemMatchesForNameMock
		}
	} as never)

	return findItemMatchesForNameMock
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("findItemMatchesForName", () => {
	// E3 — the SDK search path is built from RAW decrypted names. It must never be
	// percent-decoded: a literal "%20" (or any %XX) in a real filename has to survive
	// verbatim, otherwise the displayed path is corrupted (the same bug class as the
	// offline/camera-upload eternal-loop fixes).
	it("preserves a literal %20 in a result path verbatim (never percent-decodes)", async () => {
		mockSearchResults([
			{
				item: {
					tag: "File",
					inner: [{ uuid: "file-1" }]
				},
				path: "Documents/Invoice %20 backup.pdf"
			}
		])

		const matches = await findItemMatchesForName({ name: "Invoice" })

		expect(matches).toHaveLength(1)
		expect(matches[0]?.path).toBe("/Documents/Invoice %20 backup.pdf")
	})

	it("preserves other literal percent-escapes (%2F must not become a phantom separator)", async () => {
		mockSearchResults([
			{
				item: {
					tag: "File",
					inner: [{ uuid: "file-2" }]
				},
				path: "a%2Fb/file 50%.txt"
			}
		])

		const matches = await findItemMatchesForName({ name: "file" })

		expect(matches[0]?.path).toBe("/a%2Fb/file 50%.txt")
	})

	it("prefixes a missing leading slash and leaves an already-rooted path unchanged", async () => {
		mockSearchResults([
			{
				item: {
					tag: "File",
					inner: [{ uuid: "file-3" }]
				},
				path: "unrooted/file.txt"
			},
			{
				item: {
					tag: "NormalDir",
					inner: [{ uuid: "dir-1" }]
				},
				path: "/already/rooted"
			}
		])

		const matches = await findItemMatchesForName({ name: "x" })

		expect(matches[0]?.path).toBe("/unrooted/file.txt")
		expect(matches[1]?.path).toBe("/already/rooted")
	})

	it("filters out result tags that are neither NormalDir nor File", async () => {
		mockSearchResults([
			{
				item: {
					tag: "SharedFile",
					inner: [{ uuid: "shared-1" }]
				},
				path: "shared/file.txt"
			},
			{
				item: {
					tag: "File",
					inner: [{ uuid: "file-4" }]
				},
				path: "kept/file.txt"
			}
		])

		const matches = await findItemMatchesForName({ name: "file" })

		expect(matches).toHaveLength(1)
		expect(matches[0]?.item).toEqual({
			type: "file",
			data: { uuid: "file-4" }
		})
	})

	it("trims and lowercases the query before hitting the SDK", async () => {
		const sdkSearch = mockSearchResults([])

		await findItemMatchesForName({ name: "  MiXeD CaSe  " })

		expect(sdkSearch).toHaveBeenCalledWith("mixed case", undefined)
	})
})
