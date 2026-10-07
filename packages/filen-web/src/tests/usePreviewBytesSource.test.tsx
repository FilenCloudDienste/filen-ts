// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import type { AnyFile } from "@filen/sdk-rs"

// A byte source (an archive's entry) replaces the drive download under the same token and cache, so a
// viewer reads an entry exactly as it reads a file, and nothing it shows streams.

const { downloadFileBytes, cancelPreviewDownload } = vi.hoisted(() => ({
	downloadFileBytes: vi.fn<(file: AnyFile, token: string) => Promise<Uint8Array>>(),
	cancelPreviewDownload: vi.fn<(token: string) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, downloadLinkedFileBytesAnon: vi.fn(), cancelPreviewDownload },
	threadCount: () => 1
}))

const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")
const { clearPreviewCache, getPreviewBytes } = await import("@/features/preview/lib/previewCache")
const { PreviewByteSourceProvider, usePreviewByteSource } = await import("@/features/preview/lib/accessMode")
const { archiveEntryItem } = await import("@/features/archive/lib/entryItem")

const ARCHIVE = "aaaaaaaa-0000-4000-8000-000000000001"

beforeEach(() => {
	clearPreviewCache()
	cancelPreviewDownload.mockResolvedValue(undefined)
})

describe("usePreviewBytes with a byte source", () => {
	it("loads through the source under its token, caching by the entry's key", async () => {
		const source = vi.fn((token: string) => Promise.resolve(new Uint8Array([token.length > 0 ? 1 : 0, 2])))
		const item = archiveEntryItem(ARCHIVE, 3, "a.txt", 2, NaN)
		const wrapper = ({ children }: { children: ReactNode }) => (
			<PreviewByteSourceProvider source={source}>{children}</PreviewByteSourceProvider>
		)

		const { result } = renderHook(() => usePreviewBytes(item), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(source).toHaveBeenCalledOnce()
		expect(downloadFileBytes).not.toHaveBeenCalled()
		expect(getPreviewBytes("authed", `${ARCHIVE}#3`)).toEqual(new Uint8Array([1, 2]))
	})

	it("cancels the source's load by its token when the viewer goes", async () => {
		const source = vi.fn((_token: string) => new Promise<Uint8Array>(() => undefined))
		const item = archiveEntryItem(ARCHIVE, 4, "a.txt", 2, NaN)
		const wrapper = ({ children }: { children: ReactNode }) => (
			<PreviewByteSourceProvider source={source}>{children}</PreviewByteSourceProvider>
		)

		const { unmount } = renderHook(() => usePreviewBytes(item), { wrapper })

		await waitFor(() => {
			expect(source).toHaveBeenCalledOnce()
		})
		unmount()

		expect(cancelPreviewDownload).toHaveBeenCalledWith(source.mock.calls[0]?.[0])
	})

	it("is absent everywhere else", () => {
		const { result } = renderHook(() => usePreviewByteSource())

		expect(result.current).toBeNull()
	})
})
