// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"

// Mock the worker client so importing the hook never spawns a real Worker. Both byte methods are
// spies; the seam test asserts which one the ambient access mode selects.
const downloadFileBytes = vi.fn(() => Promise.resolve(new Uint8Array([1])))
const downloadLinkedFileBytesAnon = vi.fn(() => Promise.resolve(new Uint8Array([2])))
const cancelPreviewDownload = vi.fn()

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, downloadLinkedFileBytesAnon, cancelPreviewDownload },
	threadCount: () => 1
}))

const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")
const { PreviewAccessModeProvider } = await import("@/features/preview/lib/accessMode")
const { linkedFileIntoDriveItem } = await import("@/features/drive/lib/item")

const item = linkedFileIntoDriveItem({
	uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	name: { Decrypted: "notes.txt" },
	mime: { Decrypted: "text/plain" },
	size: 10n,
	chunks: 1n,
	region: "",
	bucket: "",
	version: 2,
	timestamp: 0n,
	fileKey: "k",
	linkedTag: true
})

describe("usePreviewBytes access-mode seam", () => {
	beforeEach(() => {
		downloadFileBytes.mockClear()
		downloadLinkedFileBytesAnon.mockClear()
	})

	it("authed (default, the whole app) hits the authed byte method only", async () => {
		const { result } = renderHook(() => usePreviewBytes(item))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(downloadLinkedFileBytesAnon).not.toHaveBeenCalled()
	})

	it("anon (a public link) hits the UNAUTHENTICATED byte method only", async () => {
		const wrapper = ({ children }: { children: ReactNode }) => createElement(PreviewAccessModeProvider, { mode: "anon", children })
		const { result } = renderHook(() => usePreviewBytes(item), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		expect(downloadFileBytes).not.toHaveBeenCalled()
	})
})
