// @vitest-environment jsdom

// The versions panel judges "current" against the file as it was when the panel opened, so it closes once
// a newer version lands or the file leaves the drive, never while one of its own writes is in flight.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, FileVersion } from "@filen/sdk-rs"
import "@/lib/i18n"

const { deleteFileVersionOp, liveFile, olderVersion } = vi.hoisted(() => {
	const file = {
		uuid: "22222222-2222-2222-2222-222222222222",
		stableUUID: "55555555-5555-5555-5555-555555555555",
		parent: "33333333-3333-3333-3333-333333333333",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	} as File

	const version = {
		uuid: "44444444-4444-4444-4444-444444444444",
		stableUUID: "55555555-5555-5555-5555-555555555555",
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 1_600_000_000_000n,
		size: 512n,
		metadata: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_600_000_000_000n, size: 512n, key: "key", version: 2 }
		}
	} as FileVersion

	return { deleteFileVersionOp: vi.fn<(version: FileVersion) => Promise<void>>(), liveFile: file, olderVersion: version }
})

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { deleteFileVersionOp } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/features/drive/queries/drive", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/queries/drive")>()
	return { ...actual, useFileVersionsQuery: () => ({ status: "success", data: [olderVersion] }) }
})

import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { narrowItem } from "@/features/drive/lib/item"
import { type FileItem } from "@/features/drive/lib/actions"
import { emitPreviewFileRevised, emitPreviewItemRemoved } from "@/features/preview/lib/previewReconcile"

function asFileItem(file: File): FileItem {
	const item = narrowItem(file)

	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

const newerRevision = asFileItem({ ...liveFile, uuid: "66666666-6666-6666-6666-666666666666" })

afterEach(() => {
	cleanup()
	deleteFileVersionOp.mockReset()
})

describe("VersionsDialog on a file superseded while open", () => {
	it("closes when a newer version of the file lands", () => {
		const onClose = vi.fn()
		render(createElement(VersionsDialog, { file: asFileItem(liveFile), onClose }))

		act(() => {
			emitPreviewFileRevised({ item: newerRevision })
		})

		expect(onClose).toHaveBeenCalled()
	})

	it("closes when the file leaves the drive", () => {
		const onClose = vi.fn()
		render(createElement(VersionsDialog, { file: asFileItem(liveFile), onClose }))

		act(() => {
			emitPreviewItemRemoved(liveFile.uuid)
		})

		expect(onClose).toHaveBeenCalled()
	})

	it("stays open for another file's revision or removal", () => {
		const onClose = vi.fn()
		const other = asFileItem({ ...liveFile, uuid: "77777777-7777-7777-7777-777777777777", stableUUID: undefined })
		render(createElement(VersionsDialog, { file: asFileItem(liveFile), onClose }))

		act(() => {
			emitPreviewFileRevised({ item: other })
			emitPreviewItemRemoved(other.data.uuid)
		})

		expect(onClose).not.toHaveBeenCalled()
	})

	it("waits for a delete in flight before closing", async () => {
		let finishDelete: () => void = () => undefined
		deleteFileVersionOp.mockReturnValueOnce(
			new Promise<void>(resolve => {
				finishDelete = resolve
			})
		)
		const onClose = vi.fn()
		render(createElement(VersionsDialog, { file: asFileItem(liveFile), onClose }))

		fireEvent.click(screen.getByRole("button", { name: "Delete this version" }))

		const confirm = screen.getAllByRole("button", { name: "Delete this version" }).at(-1)

		if (confirm === undefined) {
			throw new Error("expected the confirm button")
		}

		fireEvent.click(confirm)

		expect(deleteFileVersionOp).toHaveBeenCalledOnce()

		act(() => {
			emitPreviewFileRevised({ item: newerRevision })
		})

		expect(onClose).not.toHaveBeenCalled()

		await act(async () => {
			finishDelete()
			await Promise.resolve()
		})

		expect(onClose).toHaveBeenCalled()
	})
})
