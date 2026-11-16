// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import type { ByteOrigin, OriginAccess } from "@/lib/sdk/byteOrigin"

// A provided origin (an archive's entry) replaces the drive download under the same token and cache, so a
// viewer reads an entry exactly as it reads a file, and nothing it shows streams.

const { downloadOriginBytes, cancelPreviewDownload } = vi.hoisted(() => ({
	downloadOriginBytes: vi.fn<(origin: ByteOrigin, access: OriginAccess, cap: number, token: string) => Promise<Uint8Array>>(),
	cancelPreviewDownload: vi.fn<(token: string) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadOriginBytes, cancelPreviewDownload },
	threadCount: () => 1
}))

const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")
const { clearPreviewCache, getPreviewBytes } = await import("@/features/preview/lib/previewCache")
const { PreviewByteOriginProvider, useProvidedPreviewOrigin } = await import("@/features/preview/lib/accessMode")
const { archiveEntryItem } = await import("@/features/archive/lib/entryItem")

const ARCHIVE = "aaaaaaaa-0000-4000-8000-000000000001"

function entryOrigin(index: number): ByteOrigin {
	return {
		kind: "entry",
		reader: "reader-1",
		entry: { archive: ARCHIVE, index },
		size: 2,
		access: "whole",
		anon: false,
		cacheKey: `${ARCHIVE}#${String(index)}`
	}
}

beforeEach(() => {
	clearPreviewCache()
	cancelPreviewDownload.mockResolvedValue(undefined)
})

describe("usePreviewBytes with a provided origin", () => {
	it("loads through the origin under its token, caching by the entry's key", async () => {
		downloadOriginBytes.mockImplementation((_origin, _access, _cap, token) =>
			Promise.resolve(new Uint8Array([token.length > 0 ? 1 : 0, 2]))
		)

		const origin = entryOrigin(3)
		const item = archiveEntryItem(ARCHIVE, 3, "a.txt", 2, NaN)
		const wrapper = ({ children }: { children: ReactNode }) => (
			<PreviewByteOriginProvider origin={origin}>{children}</PreviewByteOriginProvider>
		)

		const { result } = renderHook(() => usePreviewBytes(item), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(downloadOriginBytes).toHaveBeenCalledOnce()
		expect(downloadOriginBytes.mock.calls[0]?.[0]).toBe(origin)
		expect(getPreviewBytes("authed", `${ARCHIVE}#3`)).toEqual(new Uint8Array([1, 2]))
	})

	it("cancels the origin's load by its token when the viewer goes", async () => {
		downloadOriginBytes.mockImplementation(() => new Promise<Uint8Array>(() => undefined))

		const origin = entryOrigin(4)
		const item = archiveEntryItem(ARCHIVE, 4, "a.txt", 2, NaN)
		const wrapper = ({ children }: { children: ReactNode }) => (
			<PreviewByteOriginProvider origin={origin}>{children}</PreviewByteOriginProvider>
		)

		const { unmount } = renderHook(() => usePreviewBytes(item), { wrapper })

		await waitFor(() => {
			expect(downloadOriginBytes).toHaveBeenCalledOnce()
		})
		unmount()

		expect(cancelPreviewDownload).toHaveBeenCalledWith(downloadOriginBytes.mock.calls[0]?.[3])
	})

	it("is absent everywhere else", () => {
		const { result } = renderHook(() => useProvidedPreviewOrigin())

		expect(result.current).toBeNull()
	})
})
