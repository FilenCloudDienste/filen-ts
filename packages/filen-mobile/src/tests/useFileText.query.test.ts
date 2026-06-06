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
			inner: unknown
			constructor(v0: unknown) {
				this.inner = Object.freeze([v0])
			}
		},
		Shared: class {
			tag = "Shared"
			inner: unknown
			constructor(v0: unknown) {
				this.inner = Object.freeze([v0])
			}
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

import { fetchData } from "@/queries/useFileText.query"
import { type UseFileTextQueryParams } from "@/queries/useFileText.query"

/** Create a minimal File-like object whose text() resolves to the given string. */
function makeFileLike(text: string) {
	return {
		text: vi.fn().mockResolvedValue(text),
		exists: true,
		uri: "file:///cache/test.txt"
	}
}

describe("fetchData (useFileText.query)", () => {
	beforeEach(() => {
		mockResolveFile.mockReset()
	})

	it("returns the string from file.text()", async () => {
		const content = "hello from the file"
		mockResolveFile.mockResolvedValueOnce(makeFileLike(content))

		const params: UseFileTextQueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/note.txt", name: "note.txt" }
		}
		const result = await fetchData(params)

		expect(result).toBe(content)
	})

	it("returns an empty string when file.text() resolves to an empty string", async () => {
		mockResolveFile.mockResolvedValueOnce(makeFileLike(""))

		const params: UseFileTextQueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/empty.txt", name: "empty.txt" }
		}
		const result = await fetchData(params)

		expect(result).toBe("")
	})

	it("propagates an error thrown by resolveFile", async () => {
		mockResolveFile.mockRejectedValueOnce(new Error("Drive item not found or is not a file"))

		const params: UseFileTextQueryParams = { type: "drive", data: { uuid: "ghost-uuid" } }

		await expect(fetchData(params)).rejects.toThrow("Drive item not found or is not a file")
	})

	it("forwards the AbortSignal to resolveFile", async () => {
		const content = "signal test"
		mockResolveFile.mockResolvedValueOnce(makeFileLike(content))

		const signal = new AbortController().signal
		const params: UseFileTextQueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/x.txt", name: "x.txt" }
		}

		await fetchData({ ...params, signal })

		expect(mockResolveFile).toHaveBeenCalledWith({ ...params, signal }, signal)
	})

	it("calls file.text() exactly once on the resolved file object", async () => {
		const fileLike = makeFileLike("exactly once")
		mockResolveFile.mockResolvedValueOnce(fileLike)

		const params: UseFileTextQueryParams = {
			type: "drive",
			data: { uuid: "some-uuid" }
		}

		await fetchData(params)

		expect(fileLike.text).toHaveBeenCalledOnce()
	})
})
