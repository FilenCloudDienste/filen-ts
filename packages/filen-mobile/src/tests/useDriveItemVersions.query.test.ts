import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockGetSdkClients, mockListFileVersions, cacheFileUuidToNormalFile } = vi.hoisted(() => {
	const cacheFileUuidToNormalFile = new Map<string, unknown>()
	const mockListFileVersions = vi.fn()

	return {
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				listFileVersions: mockListFileVersions
			}
		}),
		mockListFileVersions,
		cacheFileUuidToNormalFile
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => {
	const real = await import("@/tests/mocks/filenUtils")
	const { sortParams } = await import("@filen/utils")

	return {
		...real,
		sortParams
	}
})

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		set: vi.fn(),
		get: vi.fn()
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		fileUuidToNormalFile: cacheFileUuidToNormalFile
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@filen/sdk-rs", () => ({}))

import { fetchData } from "@/features/drive/queries/useDriveItemVersions.query"

beforeEach(() => {
	mockGetSdkClients.mockReset()
	mockListFileVersions.mockReset()
	cacheFileUuidToNormalFile.clear()

	mockGetSdkClients.mockResolvedValue({
		authedSdkClient: {
			listFileVersions: mockListFileVersions
		}
	})
})

describe("fetchData — cache miss early return", () => {
	it("returns empty array without any SDK call when uuid has no cache entry", async () => {
		const result = await fetchData({ uuid: "non-existent" })

		expect(result).toEqual([])
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockListFileVersions).not.toHaveBeenCalled()
	})

	it("calls listFileVersions and forwards its result when cache entry exists", async () => {
		const fakeFile = { uuid: "file-with-versions", size: 100n, region: "us-east", bucket: "b", chunks: 1n, timestamp: 0n, meta: {} }
		const fakeVersions = [
			{ id: 1n, timestamp: 1000n },
			{ id: 2n, timestamp: 2000n }
		]

		cacheFileUuidToNormalFile.set("file-with-versions", fakeFile)
		mockListFileVersions.mockResolvedValue(fakeVersions)

		const result = await fetchData({ uuid: "file-with-versions" })

		expect(mockListFileVersions).toHaveBeenCalledWith(fakeFile, undefined)
		expect(result).toBe(fakeVersions)
	})

	it("returns empty array for a second distinct uuid with no cache entry, even after first uuid succeeds", async () => {
		const fakeFile = { uuid: "file-a" }

		cacheFileUuidToNormalFile.set("file-a", fakeFile)
		mockListFileVersions.mockResolvedValue([{ id: 1n }])

		await fetchData({ uuid: "file-a" })

		const result = await fetchData({ uuid: "file-b" })

		expect(result).toEqual([])
	})

	it("forwards the AbortSignal to listFileVersions when provided", async () => {
		const fakeFile = { uuid: "file-signal" }

		cacheFileUuidToNormalFile.set("file-signal", fakeFile)
		mockListFileVersions.mockResolvedValue([])

		const controller = new AbortController()

		await fetchData({ uuid: "file-signal", signal: controller.signal })

		expect(mockListFileVersions).toHaveBeenCalledWith(fakeFile, { signal: controller.signal })
	})

	it("does not call listFileVersions when signal is not provided (passes undefined)", async () => {
		const fakeFile = { uuid: "file-no-signal" }

		cacheFileUuidToNormalFile.set("file-no-signal", fakeFile)
		mockListFileVersions.mockResolvedValue([])

		await fetchData({ uuid: "file-no-signal" })

		expect(mockListFileVersions).toHaveBeenCalledWith(fakeFile, undefined)
	})
})
