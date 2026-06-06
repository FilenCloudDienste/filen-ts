import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockResolveFile } = vi.hoisted(() => ({
	mockResolveFile: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	sortParams: (p: Record<string, unknown>) => {
		const keys = Object.keys(p).sort()
		const result: Record<string, unknown> = {}

		for (const k of keys) {
			result[k] = p[k]
		}

		return result
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyFile: {
		File: class {
			tag = "File"
			constructor(public inner: unknown) {}
		},
		Shared: class {
			tag = "Shared"
			constructor(public inner: unknown) {}
		}
	},
	ManagedFuture: { new: vi.fn(() => ({})) }
}))

vi.mock("@/queries/fileSource", () => ({
	resolveFile: mockResolveFile
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: vi.fn(),
		set: vi.fn()
	}
}))

import { fetchData } from "@/queries/useFileUri.query"
import { type UseFileUriQueryParams } from "@/queries/useFileUri.query"

/** Create a minimal File-like object with a given uri property. */
function makeFileLike(uri: string) {
	return {
		uri,
		exists: true,
		text: vi.fn().mockResolvedValue(""),
		bytes: vi.fn().mockResolvedValue(new Uint8Array([]))
	}
}

describe("fetchData (useFileUri.query)", () => {
	beforeEach(() => {
		mockResolveFile.mockReset()
	})

	it("returns { uri: file.uri } and not the File object itself", async () => {
		const fileUri = "file:///cache/filen/test-uuid.bin"
		const fileLike = makeFileLike(fileUri)
		mockResolveFile.mockResolvedValueOnce(fileLike)

		const params: UseFileUriQueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/file.bin", name: "file.bin" }
		}
		const result = await fetchData(params)

		expect(result).toEqual({ uri: fileUri })
		expect(result).not.toBe(fileLike)
	})

	it("extracts exactly the .uri field — extra file properties are not included in the result", async () => {
		const fileLike = makeFileLike("file:///cache/filen/extract-test.bin")
		mockResolveFile.mockResolvedValueOnce(fileLike)

		const params: UseFileUriQueryParams = {
			type: "drive",
			data: { uuid: "extract-test-uuid" }
		}
		const result = await fetchData(params)

		expect(Object.keys(result)).toEqual(["uri"])
		expect(result.uri).toBe("file:///cache/filen/extract-test.bin")
	})

	it("propagates a rejection from resolveFile", async () => {
		mockResolveFile.mockRejectedValueOnce(new Error("Drive item not found or is not a file"))

		const params: UseFileUriQueryParams = { type: "drive", data: { uuid: "ghost-uuid" } }

		await expect(fetchData(params)).rejects.toThrow("Drive item not found or is not a file")
	})

	it("forwards the AbortSignal to resolveFile", async () => {
		const fileUri = "file:///cache/filen/signal-test.bin"
		mockResolveFile.mockResolvedValueOnce(makeFileLike(fileUri))

		const signal = new AbortController().signal
		const params: UseFileUriQueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/x.bin", name: "x.bin" }
		}

		await fetchData({ ...params, signal })

		expect(mockResolveFile).toHaveBeenCalledWith({ ...params, signal }, signal)
	})

	it("calls resolveFile exactly once per fetchData invocation", async () => {
		mockResolveFile.mockResolvedValue(makeFileLike("file:///cache/filen/count.bin"))

		const params: UseFileUriQueryParams = {
			type: "drive",
			data: { uuid: "count-uuid" }
		}

		await fetchData(params)

		expect(mockResolveFile).toHaveBeenCalledOnce()
	})
})
