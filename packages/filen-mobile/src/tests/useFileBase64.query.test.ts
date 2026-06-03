import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockResolveFile } = vi.hoisted(() => ({
	mockResolveFile: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...await import("@/tests/mocks/filenUtils"),
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

// react-native-quick-crypto Buffer is used for base64 encoding.
// The shared mock re-exports the Node.js Buffer which is sufficient.
vi.mock("react-native-quick-crypto", async () => await import("@/tests/mocks/reactNativeQuickCrypto"))

import { fetchData } from "@/queries/useFileBase64.query"
import { type UseFileBase64QueryParams } from "@/queries/useFileBase64.query"

/** Create a minimal File-like object whose bytes() resolves to the given array. */
function makeFileLike(bytes: Uint8Array) {
	return {
		bytes: vi.fn().mockResolvedValue(bytes),
		exists: true,
		uri: "file:///cache/test.bin"
	}
}

describe("fetchData (useFileBase64.query)", () => {
	beforeEach(() => {
		mockResolveFile.mockReset()
	})

	it("returns base64 string for a simple byte array [1, 2, 3]", async () => {
		const bytes = new Uint8Array([1, 2, 3])
		mockResolveFile.mockResolvedValueOnce(makeFileLike(bytes))

		const params: UseFileBase64QueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/file.bin", name: "file.bin" }
		}
		const result = await fetchData(params)

		// Buffer.from(Uint8Array).toString("base64") should round-trip
		const decoded = Buffer.from(result, "base64")

		expect(Array.from(decoded)).toEqual([1, 2, 3])
	})

	it("returns an empty string for an empty byte array", async () => {
		const bytes = new Uint8Array([])
		mockResolveFile.mockResolvedValueOnce(makeFileLike(bytes))

		const params: UseFileBase64QueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/empty.bin", name: "empty.bin" }
		}
		const result = await fetchData(params)

		expect(result).toBe("")
	})

	it("correctly encodes all 256 possible byte values", async () => {
		const bytes = new Uint8Array(256)

		for (let i = 0; i < 256; i++) {
			bytes[i] = i
		}

		mockResolveFile.mockResolvedValueOnce(makeFileLike(bytes))

		const params: UseFileBase64QueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/all-bytes.bin", name: "all-bytes.bin" }
		}
		const result = await fetchData(params)

		// Must be valid base64 — no non-base64 characters
		expect(result).toMatch(/^[A-Za-z0-9+/]*(={0,2})$/)

		// Must round-trip losslessly
		const decoded = Buffer.from(result, "base64")

		expect(decoded.length).toBe(256)

		for (let i = 0; i < 256; i++) {
			expect(decoded[i]).toBe(i)
		}
	})

	it("propagates an error thrown by resolveFile", async () => {
		mockResolveFile.mockRejectedValueOnce(new Error("Drive item not found or is not a file"))

		const params: UseFileBase64QueryParams = { type: "drive", data: { uuid: "ghost-uuid" } }

		await expect(fetchData(params)).rejects.toThrow("Drive item not found or is not a file")
	})

	it("calls resolveFile with the params and signal", async () => {
		const bytes = new Uint8Array([42])
		mockResolveFile.mockResolvedValueOnce(makeFileLike(bytes))

		const signal = new AbortController().signal
		const params: UseFileBase64QueryParams = {
			type: "external",
			data: { url: "https://cdn.example.com/x.bin", name: "x.bin" }
		}

		await fetchData({ ...params, signal })

		expect(mockResolveFile).toHaveBeenCalledWith({ ...params, signal }, signal)
	})
})
