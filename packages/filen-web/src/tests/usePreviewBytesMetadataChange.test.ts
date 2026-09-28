// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { AnyFile, LinkedFile } from "@filen/sdk-rs"

// A favorite toggle or rename hands the viewer a new item object for the same uuid while its buffer is
// still downloading. That must neither cancel nor restart the download.

const { downloadFileBytes, cancelPreviewDownload } = vi.hoisted(() => ({
	downloadFileBytes: vi.fn<(file: AnyFile, token: string) => Promise<Uint8Array>>(),
	cancelPreviewDownload: vi.fn<(token: string) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, downloadLinkedFileBytesAnon: vi.fn(), cancelPreviewDownload },
	threadCount: () => 1
}))

const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")
const { clearPreviewCache } = await import("@/features/preview/lib/previewCache")
const { linkedFileIntoDriveItem } = await import("@/features/drive/lib/item")

function makeItem(uuid: LinkedFile["uuid"], name: string) {
	return linkedFileIntoDriveItem({
		uuid,
		name: { Decrypted: name },
		mime: { Decrypted: "text/plain" },
		size: 3n,
		chunks: 1n,
		region: "",
		bucket: "",
		version: 2,
		timestamp: 0n,
		fileKey: "k",
		downloadable: true,
		linkedTag: true,
		canMakeThumbnail: false
	})
}

const UUID_A = "aaaaaaaa-0000-0000-0000-000000000001"
const UUID_B = "bbbbbbbb-0000-0000-0000-000000000002"

beforeEach(() => {
	clearPreviewCache()
	cancelPreviewDownload.mockResolvedValue(undefined)
})

describe("usePreviewBytes on a metadata-only item change", () => {
	it("keeps the in-flight download running when the same file arrives renamed", async () => {
		let finish: (bytes: Uint8Array) => void = () => undefined
		downloadFileBytes.mockImplementation(
			() =>
				new Promise<Uint8Array>(resolve => {
					finish = resolve
				})
		)

		const { result, rerender } = renderHook(({ item }) => usePreviewBytes(item), { initialProps: { item: makeItem(UUID_A, "a.txt") } })

		rerender({ item: makeItem(UUID_A, "renamed.txt") })
		finish(new Uint8Array([1, 2, 3]))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(cancelPreviewDownload).not.toHaveBeenCalled()
	})

	it("still cancels and reloads when the uuid changes", async () => {
		downloadFileBytes.mockImplementation(() => new Promise<Uint8Array>(() => undefined))

		const { rerender } = renderHook(({ item }) => usePreviewBytes(item), { initialProps: { item: makeItem(UUID_A, "a.txt") } })

		rerender({ item: makeItem(UUID_B, "b.txt") })

		await waitFor(() => {
			expect(downloadFileBytes).toHaveBeenCalledTimes(2)
		})

		expect(cancelPreviewDownload).toHaveBeenCalledTimes(1)
	})
})
