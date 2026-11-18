// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { linkedFileItem, mockLinkedFile } from "@/tests/fixtures/sdk"
import { bytesOrigin, originAnonSafe, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"

const downloadOriginBytes = vi.fn((_origin: ByteOrigin, _access: OriginAccess, _cap: number, _token: string) =>
	Promise.resolve(Uint8Array.of(9, 9))
)
const cancelPreviewDownload = vi.fn()

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadOriginBytes, cancelPreviewDownload },
	threadCount: () => 1
}))

const { PreviewAccessModeProvider, PreviewByteOriginProvider, usePreviewOrigin, useProvidedPreviewOrigin } =
	await import("@/features/preview/lib/accessMode")
const { loadOriginBytes } = await import("@/features/preview/lib/origin/loadBytes")
const { openByteReader } = await import("@/features/preview/lib/origin/byteReader")
const { openOriginPorts, openOriginRangeSource } = await import("@/features/preview/lib/origin/rangeSource")
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

	it.each<[string, ByteOrigin]>([
		["a drive file", { kind: "file", file }],
		[
			"an entry of an archive opened through the session",
			{ kind: "entry", reader: "r", entry: { archive: file.uuid, index: 1 }, size: 2, access: "whole", anon: false, cacheKey: "k" }
		]
	])("refuses %s provided under a public link", (_name, origin) => {
		const anon = ({ children }: { children: ReactNode }) =>
			createElement(PreviewAccessModeProvider, {
				mode: "anon",
				children: createElement(PreviewByteOriginProvider, { origin, children })
			})
		const authed = ({ children }: { children: ReactNode }) => createElement(PreviewByteOriginProvider, { origin, children })

		vi.spyOn(console, "error").mockImplementation(() => undefined)

		expect(() => renderHook(() => usePreviewOrigin(item), { wrapper: anon })).toThrow("needs a session")
		expect(() => renderHook(() => useProvidedPreviewOrigin(), { wrapper: anon })).toThrow("needs a session")
		expect(renderHook(() => usePreviewOrigin(item), { wrapper: authed }).result.current).toBe(origin)
		vi.restoreAllMocks()
	})

	it("refuses a directory rather than fabricate an origin for it", () => {
		const dir = { ...item, type: "directory" } as unknown as typeof item

		vi.spyOn(console, "error").mockImplementation(() => undefined)

		expect(() => renderHook(() => usePreviewOrigin(dir))).toThrow("directory")
		vi.restoreAllMocks()
	})
})

describe("loadOriginBytes", () => {
	it("loads a file through the SDK worker and caches it under the file's uuid", async () => {
		const bytes = await loadOriginBytes({ kind: "file", file }, "t1", { access: "authed", cap: 10, scope: "authed" })

		expect(bytes).toEqual(Uint8Array.of(9, 9))
		expect(downloadOriginBytes).toHaveBeenCalledWith({ kind: "file", file }, "authed", 10, "t1")
		expect(getPreviewBytes("authed", file.uuid)).toBe(bytes)
	})

	it("refuses an origin above the cap before reading", async () => {
		downloadOriginBytes.mockClear()

		await expect(loadOriginBytes({ kind: "file", file }, "t1", { access: "authed", cap: 1, scope: "authed" })).rejects.toThrow("cap")
		expect(downloadOriginBytes).not.toHaveBeenCalled()
	})

	it("reads a bytes origin from its Blob and never caches it", async () => {
		const origin = bytesOrigin(new Blob([Uint8Array.of(4, 5, 6)]), "parent/att0")

		await expect(loadOriginBytes(origin, "t1", { access: "authed", cap: 10, scope: "authed" })).resolves.toEqual(Uint8Array.of(4, 5, 6))
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

	it("frees the room of the bytes it takes", async () => {
		for (const key of ["a", "b", "c", "d"]) {
			await loadPreviewBytes("authed", key, 1, () => Promise.resolve(Uint8Array.of(1)))
		}

		takePreviewBytes("authed", "b")
		await loadPreviewBytes("authed", "e", 1, () => Promise.resolve(Uint8Array.of(1)))

		// Four entries fit: without the take, "a" would have made way for "e".
		expect(getPreviewBytes("authed", "a")).toBeDefined()
		expect(getPreviewBytes("authed", "e")).toBeDefined()
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
		const reader = await openByteReader(origin, "t1", { access: "authed" })

		expect(reader.size).toBe(8)
		await expect(reader.read(2, 3)).resolves.toEqual(Uint8Array.of(2, 3, 4))
		await expect(reader.read(6, 10)).resolves.toEqual(Uint8Array.of(6, 7))
		await expect(reader.read(9, 1)).resolves.toEqual(new Uint8Array(0))
		reader.close()
	})

	it("serves ranges through page ports that close with the source", async () => {
		const source = await openOriginRangeSource(origin, "t1", { access: "authed", limit: 4 })
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

	// A worker reading through a port of its own needs no reader on the page: none is opened until a port is asked for.
	it("opens ports only when asked, and ends them all with close", async () => {
		const ports = openOriginPorts(origin, "t2", { access: "authed" })
		const signal = new AbortController().signal

		expect(ports.size).toBe(8)

		const reader = rangePortReader(await ports.port())
		const lost = new Promise<void>(resolve => {
			reader.onLost(resolve)
		})

		expect([...(await reader.readRange(0, 2, signal))]).toEqual([0, 1])
		ports.close()
		await lost
		await expect(ports.port()).rejects.toThrow("closed")
	})

	it("cancels the token of an SDK-served origin's ports on close", () => {
		const ports = openOriginPorts({ kind: "linkedFile", file }, "t3", { access: "anon" })

		ports.close()
		expect(cancelPreviewDownload).toHaveBeenCalledWith("t3")
	})
})
