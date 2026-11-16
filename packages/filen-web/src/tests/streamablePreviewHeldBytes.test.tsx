// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import type { File } from "@filen/sdk-rs"

// An image whose bytes the preview already holds (a buffered slot revisited, an edited image just saved) shows from
// memory rather than streaming the file again.

const { streamUrl } = vi.hoisted(() => ({ streamUrl: vi.fn(() => ({ status: "pending" as const, refetch: vi.fn() })) }))

vi.mock("@/features/preview/lib/previewStream", () => ({ isMediaStreamAvailable: () => true }))
vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: () => "image/jpeg" }))
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
			const bytes = getPreviewBytes(previewCacheScope("authed", undefined), item.data.uuid)

			return bytes === undefined ? { status: "pending" } : { status: "success", bytes, refetch: vi.fn() }
		}
	}
})

import "@/lib/i18n"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { clearPreviewCache, loadPreviewBytes } from "@/features/preview/lib/previewCache"
import { PreviewAccessModeProvider, PreviewByteOriginProvider, previewCacheScope } from "@/features/preview/lib/accessMode"
import type { ByteOrigin, EntryAccessKind } from "@/lib/sdk/byteOrigin"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

function photo(label: string) {
	const file: File = {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 3n,
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

function preview(label: string) {
	return createElement(StreamablePreview, {
		item: photo(label),
		render: (url: string, onError: (() => void) | undefined) =>
			createElement("img", { alt: onError === undefined ? "buffered" : "streamed", src: url })
	})
}

function show(label: string): void {
	render(preview(label))
}

function entry(access: EntryAccessKind): ByteOrigin {
	return { kind: "entry", reader: "r", entry: { archive: testUuid("zip"), index: 1 }, size: 3, access, anon: false, cacheKey: "k" }
}

beforeEach(() => {
	clearPreviewCache()
	streamUrl.mockClear()
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

	it("never streams a public link's image", () => {
		render(createElement(PreviewAccessModeProvider, { mode: "anon", children: preview("linked") }))

		expect(streamUrl).not.toHaveBeenCalled()
	})

	it("streams a file whose bytes it does not hold", () => {
		show("streamed")

		expect(streamUrl).toHaveBeenCalled()
		expect(screen.queryByAltText("buffered")).toBeNull()
	})
})
