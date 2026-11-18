// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { bytesOrigin, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// A file held in another (a message's attachment) opens from a Blob origin with the viewer its kind gets, read-only,
// the Blob its only copy; back and download are the container's to handle.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([])
}))
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadOriginBytes: vi.fn(), cancelPreviewDownload: () => Promise.resolve() },
	threadCount: () => 1
}))

const { NestedFileViewer } = await import("@/features/preview/components/nestedFileViewer")
const { embeddedFileItem } = await import("@/features/preview/lib/embeddedFileItem")
const { getPreviewBytes } = await import("@/features/preview/lib/previewCache")

registerAllActions()

afterEach(() => {
	cleanup()
})

describe("NestedFileViewer", () => {
	it("opens a Blob-held file with its kind's viewer, read-only", async () => {
		const onBack = vi.fn()
		const onDownload = vi.fn()
		const blob = new Blob(["notes from an attachment\n"])
		const origin = bytesOrigin(blob, "mail-1#att0")
		const item = embeddedFileItem("mail-1#att0", "notes.txt", blob.size, NaN)

		render(
			<NestedFileViewer
				item={item}
				origin={origin}
				category="text"
				references={null}
				backLabel="Back to the message"
				onBack={onBack}
				onDownload={onDownload}
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(await screen.findByText("notes from an attachment")).toBeTruthy()
		expect(screen.getByText("notes.txt")).toBeTruthy()
		expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("false")
		// The Blob is the copy: nothing more is kept in the preview cache.
		expect(getPreviewBytes("authed", "mail-1#att0")).toBeUndefined()

		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		fireEvent.click(screen.getByRole("button", { name: "Back to the message" }))

		expect(onDownload).toHaveBeenCalledOnce()
		expect(onBack).toHaveBeenCalledOnce()
	})

	it("hides download where the file may not be saved, and shows a replacement instead of the file", () => {
		const blob = new Blob(["x"])

		render(
			<NestedFileViewer
				item={embeddedFileItem("mail-1#att1", "x.txt", 1, NaN)}
				origin={bytesOrigin(blob, "mail-1#att1")}
				category="text"
				references={null}
				backLabel="Back"
				onBack={vi.fn()}
				onDownload={null}
				replacement={<p>Password needed</p>}
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(screen.queryByRole("button", { name: "Download" })).toBeNull()
		expect(screen.getByText("Password needed")).toBeTruthy()
	})
})

describe("embeddedFileItem", () => {
	it("is its own parent, keyed by its origin, typed as the inline route serves its extension", () => {
		const item = embeddedFileItem("mail-1#att2", "chart.png", 10, 1_700_000_000_000)

		expect(item.data.uuid).toBe("mail-1#att2")
		expect(item.data.parent).toBe("mail-1#att2")
		expect(item.data.decryptedMeta).toMatchObject({ name: "chart.png", mime: "image/png", size: 10n })
		expect(embeddedFileItem("k", "blob.unknownext", 1, NaN).data.decryptedMeta).toMatchObject({ mime: "application/octet-stream" })
	})

	it("shows the replacement its content read's kind asks for instead of that viewer, and the viewer for a named kind", async () => {
		const item = embeddedFileItem("arc#4", "clip.mp4", 3, NaN)
		const origin: ByteOrigin = {
			kind: "entry",
			reader: "lease",
			entry: { archive: "a0000000-0000-0000-0000-000000000000", index: 4 },
			size: 3,
			access: "whole",
			anon: false,
			cacheKey: "arc#4"
		}
		const props = {
			item,
			origin,
			references: null,
			backLabel: "Back",
			onBack: vi.fn(),
			onDownload: null,
			sniffedReplacement: (category: string) => (category === "video" ? <p>Extract to play</p> : undefined)
		} as const

		const { unmount } = render(
			<NestedFileViewer
				{...props}
				category={null}
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(await screen.findByText("Extract to play")).toBeTruthy()
		unmount()
		render(
			<NestedFileViewer
				{...props}
				category="text"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)
		expect(screen.queryByText("Extract to play")).toBeNull()
	})
})
