// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { File } from "@filen/sdk-rs"

// An image whose bytes the preview already holds (a buffered slot revisited, an edited image just saved) shows from
// memory rather than streaming the file again; one too large to load whole is never loaded whole.

interface StreamState {
	available: boolean
	later: Promise<boolean>
	contentType: string | null
	// Who hears of a service worker taking control of the page later.
	onAvailable: Set<() => void>
}

const { streamUrl, stream, bytesRead } = vi.hoisted(() => {
	const state: StreamState = { available: true, later: Promise.resolve(true), contentType: "image/jpeg", onAvailable: new Set() }

	return { streamUrl: vi.fn(() => ({ status: "pending" as const, refetch: vi.fn() })), stream: state, bytesRead: vi.fn() }
})

vi.mock("@/features/preview/lib/previewStream", () => ({
	isMediaStreamAvailable: () => stream.available,
	waitForMediaStream: () => stream.later,
	onMediaStreamAvailable: (listener: () => void) => {
		stream.onAvailable.add(listener)

		return () => {
			stream.onAvailable.delete(listener)
		}
	}
}))
vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: () => stream.contentType }))
vi.mock("@/features/preview/hooks/usePreviewStreamUrl", () => ({ usePreviewStreamUrl: streamUrl }))
vi.mock("@/lib/useObjectUrl", () => ({ useObjectUrl: () => "blob:held" }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/preview/hooks/usePreviewBytes", async () => {
	const { getPreviewBytes } = await vi.importActual<typeof import("@/features/preview/lib/previewCache")>(
		"@/features/preview/lib/previewCache"
	)
	const { previewCacheScope } =
		await vi.importActual<typeof import("@/features/preview/lib/accessMode")>("@/features/preview/lib/accessMode")

	return {
		usePreviewBytes: (item: { data: { uuid: string } }) => {
			bytesRead(item.data.uuid)

			const bytes = getPreviewBytes(previewCacheScope("authed", undefined), item.data.uuid)

			return bytes === undefined ? { status: "pending" } : { status: "success", bytes, refetch: vi.fn() }
		}
	}
})

import "@/lib/i18n"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { clearPreviewCache, loadPreviewBytes } from "@/features/preview/lib/previewCache"
import {
	PreviewAccessModeProvider,
	PreviewByteOriginProvider,
	PreviewDownloadableProvider,
	previewCacheScope
} from "@/features/preview/lib/accessMode"
import type { ByteOrigin, EntryAccessKind } from "@/lib/sdk/byteOrigin"
import { narrowItem } from "@/features/drive/lib/item"
import { PREVIEW_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import { testUuid } from "@/tests/support/uuid"

function photo(label: string, size = 3n) {
	const file: File = {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: "a.jpg", mime: "image/jpeg", modified: 0n, size: 3n, key: "k", version: 2 } }
	}

	return narrowItem(file)
}

function preview(label: string, size?: bigint) {
	return createElement(StreamablePreview, {
		item: photo(label, size),
		render: (url: string, onError: ((image: HTMLImageElement) => void) | undefined) =>
			createElement("img", { alt: onError === undefined ? "buffered" : "streamed", src: url })
	})
}

function show(label: string, size?: bigint): void {
	render(preview(label, size))
}

function entry(access: EntryAccessKind): ByteOrigin {
	return { kind: "entry", reader: "r", entry: { archive: testUuid("zip"), index: 1 }, size: 3, access, anon: false, cacheKey: "k" }
}

beforeEach(() => {
	clearPreviewCache()
	streamUrl.mockClear()
	bytesRead.mockClear()
	stream.available = true
	stream.later = Promise.resolve(true)
	stream.contentType = "image/jpeg"
})

afterEach(() => {
	cleanup()
})

describe("StreamablePreview", () => {
	it("shows bytes it already holds from memory, never registering a stream", async () => {
		await loadPreviewBytes(previewCacheScope("authed", undefined), testUuid("held"), 3, () =>
			Promise.resolve(new Uint8Array([1, 2, 3]))
		)

		show("held")

		expect(screen.getByAltText("buffered").getAttribute("src")).toBe("blob:held")
		expect(streamUrl).not.toHaveBeenCalled()
	})

	it("streams an archive's entry read by range, and buffers one read whole", () => {
		render(createElement(PreviewByteOriginProvider, { origin: entry("mapped"), children: preview("ranged") }))
		expect(streamUrl).toHaveBeenCalled()

		cleanup()
		streamUrl.mockClear()
		render(createElement(PreviewByteOriginProvider, { origin: entry("whole"), children: preview("whole") }))
		expect(streamUrl).not.toHaveBeenCalled()
	})

	it("streams a public link's image", () => {
		render(createElement(PreviewAccessModeProvider, { mode: "anon", children: preview("linked", PREVIEW_MAX_BYTES + 1n) }))

		expect(streamUrl).toHaveBeenCalled()
		expect(bytesRead).not.toHaveBeenCalled()
	})

	describe("above the buffer cap", () => {
		const big = PREVIEW_MAX_BYTES + 1n

		it("waits for a service worker to control the page, then streams", async () => {
			stream.available = false
			render(createElement(PreviewAccessModeProvider, { mode: "anon", children: preview("waits", big) }))

			expect(streamUrl).not.toHaveBeenCalled()
			await waitFor(() => {
				expect(streamUrl).toHaveBeenCalled()
			})
			expect(bytesRead).not.toHaveBeenCalled()
		})

		it("says it is too large when no service worker takes control", async () => {
			stream.available = false
			stream.later = Promise.resolve(false)
			show("noWorker", big)

			expect(await screen.findByText("This file is too large to show here.")).toBeTruthy()
			expect(streamUrl).not.toHaveBeenCalled()
			expect(bytesRead).not.toHaveBeenCalled()
		})

		it("streams once a service worker takes control after the card showed", async () => {
			stream.available = false
			stream.later = Promise.resolve(false)
			render(createElement(PreviewAccessModeProvider, { mode: "anon", children: preview("lateWorker", big) }))

			expect(await screen.findByText("This file is too large to show here.")).toBeTruthy()
			expect(streamUrl).not.toHaveBeenCalled()

			stream.available = true
			act(() => {
				for (const listener of stream.onAvailable) {
					listener()
				}
			})

			expect(streamUrl).toHaveBeenCalled()
			expect(screen.queryByText("This file is too large to show here.")).toBeNull()
			expect(bytesRead).not.toHaveBeenCalled()
		})

		it("says it is too large at once when the inline route cannot serve it", () => {
			stream.contentType = null
			show("noType", big)

			expect(screen.getByText("This file is too large to show here.")).toBeTruthy()
			expect(streamUrl).not.toHaveBeenCalled()
			expect(bytesRead).not.toHaveBeenCalled()
		})

		it("offers Try again and Download when its stream fails", () => {
			const refetch = vi.fn()
			const onDownload = vi.fn()

			streamUrl.mockReturnValueOnce({ status: "error", refetch } as never)
			render(createElement(PreviewDownloadableProvider, { downloadable: true, onDownload, children: preview("failed", big) }))

			expect(screen.getByText("This preview stopped loading. Try again, or download the file.")).toBeTruthy()
			screen.getByRole("button", { name: "Download" }).click()
			expect(onDownload).toHaveBeenCalledTimes(1)
			screen.getByRole("button", { name: "Try again" }).click()
			expect(refetch).toHaveBeenCalledTimes(1)
		})

		it("still buffers at the cap", () => {
			stream.contentType = null
			show("atCap", PREVIEW_MAX_BYTES)

			expect(bytesRead).toHaveBeenCalled()
		})
	})

	it("streams a file whose bytes it does not hold", () => {
		show("streamed")

		expect(streamUrl).toHaveBeenCalled()
		expect(screen.queryByAltText("buffered")).toBeNull()
	})
})
