// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"

const preview = { type: "noPreview" } as const
const fetchRawPreview = vi.fn(() => Promise.resolve(preview))
const fetchLinkedRawPreviewAnon = vi.fn(() => Promise.resolve(preview))
const cancelPreviewDownload = vi.fn()

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { fetchRawPreview, fetchLinkedRawPreviewAnon, cancelPreviewDownload },
	threadCount: () => 1
}))

const { useRawPreview } = await import("@/features/preview/hooks/useRawPreview")
const { PreviewAccessModeProvider } = await import("@/features/preview/lib/accessMode")
const { linkedFileIntoDriveItem } = await import("@/features/drive/lib/item")

const item = linkedFileIntoDriveItem({
	uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	name: { Decrypted: "shot.NEF" },
	mime: { Decrypted: "image/x-nikon-nef" },
	size: 90_000_000n,
	chunks: 90n,
	region: "",
	bucket: "",
	version: 2,
	timestamp: 0n,
	fileKey: "k",
	linkedTag: true,
	canMakeThumbnail: true
})

describe("useRawPreview", () => {
	beforeEach(() => {
		fetchRawPreview.mockClear()
		fetchLinkedRawPreviewAnon.mockClear()
		cancelPreviewDownload.mockClear()
	})

	it("authed reads the embedded preview through the authed worker method only", async () => {
		const { result } = renderHook(() => useRawPreview(item))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(result.current.status === "success" ? result.current.preview : null).toEqual(preview)
		expect(fetchRawPreview).toHaveBeenCalledTimes(1)
		expect(fetchLinkedRawPreviewAnon).not.toHaveBeenCalled()
	})

	it("anon (a public link) reads it through the UNAUTHENTICATED worker method only", async () => {
		const wrapper = ({ children }: { children: ReactNode }) => createElement(PreviewAccessModeProvider, { mode: "anon", children })
		const { result } = renderHook(() => useRawPreview(item), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(fetchLinkedRawPreviewAnon).toHaveBeenCalledTimes(1)
		expect(fetchRawPreview).not.toHaveBeenCalled()
	})

	it("cancels the in-flight extraction by its own token on unmount", async () => {
		fetchRawPreview.mockImplementationOnce(() => new Promise(() => undefined))
		const { unmount } = renderHook(() => useRawPreview(item))

		await waitFor(() => {
			expect(fetchRawPreview).toHaveBeenCalledTimes(1)
		})

		const token = (fetchRawPreview.mock.calls[0] as unknown[] | undefined)?.[1]
		unmount()

		expect(cancelPreviewDownload).toHaveBeenCalledWith(token)
	})

	it("surfaces a worker rejection as the error state with a working retry", async () => {
		fetchRawPreview.mockImplementationOnce(() => Promise.reject(new Error("network down")))
		const { result } = renderHook(() => useRawPreview(item))

		await waitFor(() => {
			expect(result.current.status).toBe("error")
		})

		act(() => {
			result.current.refetch()
		})

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})
		expect(fetchRawPreview).toHaveBeenCalledTimes(2)
	})
})
