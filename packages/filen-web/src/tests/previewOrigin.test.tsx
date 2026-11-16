// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { linkedFileItem, mockLinkedFile } from "@/tests/fixtures/sdk"
import { bytesOrigin, originAnonSafe, type ByteOrigin } from "@/lib/sdk/byteOrigin"

const downloadOriginBytes = vi.fn((_origin: ByteOrigin, _cap: number, _token: string) => Promise.resolve(Uint8Array.of(9, 9)))
const cancelPreviewDownload = vi.fn()

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadOriginBytes, cancelPreviewDownload },
	threadCount: () => 1
}))

const { PreviewAccessModeProvider, PreviewByteOriginProvider, PreviewByteSourceProvider, usePreviewOrigin } =
	await import("@/features/preview/lib/accessMode")
const { loadOriginBytes } = await import("@/features/preview/lib/origin/loadBytes")
const { openByteReader } = await import("@/features/preview/lib/origin/byteReader")
const { openOriginRangeSource } = await import("@/features/preview/lib/origin/rangeSource")
const { clearPreviewCache, getPreviewBytes, loadPreviewBytes, takePreviewBytes } = await import("@/features/preview/lib/previewCache")
const { PREVIEW_MAX_BYTES } = await import("@/features/drive/lib/preview.logic")
const { rangePortReader } = await import("@/lib/media/rangePort")
const { runPreviewDisposers } = await import("@/lib/workers/previewDisposers")

const item = linkedFileItem("photo.jpg", { uuid: "c0000000-0000-0000-0000-000000000000", size: 2n })
const file = mockLinkedFile({ uuid: "c0000000-0000-0000-0000-000000000000", size: 2n })

beforeEach(() => {
	clearPreviewCache()
})

afterEach(() => {
	runPreviewDisposers()
})

describe("usePreviewOrigin", () => {
	it("derives a drive file in the app and a linked file under a public link", () => {
		const authed = renderHook(() => usePreviewOrigin(item))
		const anon = renderHook(() => usePreviewOrigin(item), {
			wrapper: ({ children }: { children: ReactNode }) => createElement(PreviewAccessModeProvider, { mode: "anon", children })
		})

		expect(authed.result.current.kind).toBe("file")
		expect(anon.result.current.kind).toBe("linkedFile")
		expect(originAnonSafe(anon.result.current)).toBe(true)
	})

	it("returns the provided origin, anon-safe under a public link", () => {
		const origin = bytesOrigin(new Blob([Uint8Array.of(1)]), "parent/att0")
		const { result } = renderHook(() => usePreviewOrigin(item), {
			wrapper: ({ children }: { children: ReactNode }) =>
				createElement(PreviewAccessModeProvider, {
					mode: "anon",
					children: createElement(PreviewByteOriginProvider, { origin, children })
				})
		})

		expect(result.current).toBe(origin)
		expect(originAnonSafe(result.current)).toBe(true)
	})

	it("refuses to invent a file origin under a byte source", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		expect(() =>
			renderHook(() => usePreviewOrigin(item), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(PreviewByteSourceProvider, { source: () => Promise.resolve(new Uint8Array(0)), children })
			})
		).toThrow("byte source")
	})
})

describe("loadOriginBytes", () => {
	it("loads a file through the SDK worker and caches it under the file's uuid", async () => {
		const bytes = await loadOriginBytes({ kind: "file", file }, "t1", { cap: 10, scope: "authed" })

		expect(bytes).toEqual(Uint8Array.of(9, 9))
		expect(downloadOriginBytes).toHaveBeenCalledWith({ kind: "file", file }, 10, "t1")
		expect(getPreviewBytes("authed", file.uuid)).toBe(bytes)
	})

	it("refuses an origin above the cap before reading", async () => {
		downloadOriginBytes.mockClear()

		await expect(loadOriginBytes({ kind: "file", file }, "t1", { cap: 1, scope: "authed" })).rejects.toThrow("cap")
		expect(downloadOriginBytes).not.toHaveBeenCalled()
	})

	it("reads a bytes origin from its Blob and never caches it", async () => {
		const origin = bytesOrigin(new Blob([Uint8Array.of(4, 5, 6)]), "parent/att0")

		await expect(loadOriginBytes(origin, "t1", { cap: 10, scope: "authed" })).resolves.toEqual(Uint8Array.of(4, 5, 6))
		expect(getPreviewBytes("authed", "parent/att0")).toBeUndefined()
	})
})

describe("preview cache contract", () => {
	it("takes cached bytes out for a transfer", async () => {
		const bytes = await loadPreviewBytes("authed", "u1", 3, () => Promise.resolve(Uint8Array.of(1, 2, 3)))

		expect(takePreviewBytes("authed", "u1")).toBe(bytes)
		expect(takePreviewBytes("authed", "u1")).toBeUndefined()
		expect(getPreviewBytes("authed", "u1")).toBeUndefined()
		expect(takePreviewBytes(null, "u1")).toBeUndefined()
	})

	it("makes no room for a load it will not keep", async () => {
		await loadPreviewBytes("authed", "kept", 3, () => Promise.resolve(Uint8Array.of(1, 2, 3)))
		await loadPreviewBytes("authed", "passing", Number(PREVIEW_MAX_BYTES), () => Promise.resolve(Uint8Array.of(1)), { store: false })

		expect(getPreviewBytes("authed", "kept")).toBeDefined()
		expect(getPreviewBytes("authed", "passing")).toBeUndefined()
	})
})

describe("bytes origin reads on the page", () => {
	const origin = bytesOrigin(new Blob([Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7)]), "parent/att0")

	it("reads ranges directly, cut short at the end", async () => {
		const reader = await openByteReader(origin, "t1")

		expect(reader.size).toBe(8)
		await expect(reader.read(2, 3)).resolves.toEqual(Uint8Array.of(2, 3, 4))
		await expect(reader.read(6, 10)).resolves.toEqual(Uint8Array.of(6, 7))
		await expect(reader.read(9, 1)).resolves.toEqual(new Uint8Array(0))
		reader.close()
	})

	it("serves ranges through page ports that close with the source", async () => {
		const source = await openOriginRangeSource(origin, "t1", { limit: 4 })
		const signal = new AbortController().signal

		expect(source.size).toBe(4)
		// Bytes cross the port from another realm: compare their values.
		expect([...(await source.reader.readRange(1, 3, signal))]).toEqual([1, 2])

		const other = rangePortReader(await source.port())
		const lost = new Promise<void>(resolve => {
			other.onLost(resolve)
		})

		expect([...(await other.readRange(5, 8, signal))]).toEqual([5, 6, 7])
		source.close()
		await lost
		await expect(source.port()).rejects.toThrow("closed")
		expect(cancelPreviewDownload).not.toHaveBeenCalled()
	})
})
