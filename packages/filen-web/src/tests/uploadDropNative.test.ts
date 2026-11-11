import { beforeEach, describe, expect, it, vi } from "vitest"

const { available, startNativeDrop, startUploads, startDirectoryUpload } = vi.hoisted(() => ({
	available: vi.fn(() => true),
	startNativeDrop: vi.fn((_files: File[], _entries: FileSystemEntry[], _parentUuid: string | null) => Promise.resolve()),
	startUploads: vi.fn(),
	startDirectoryUpload: vi.fn()
}))

vi.mock("@/features/transfers/lib/nativeHost", () => ({ nativeTransfersAvailable: available }))
vi.mock("@/features/transfers/lib/nativeTransfers", () => ({ startNativeDrop }))
vi.mock("@/features/drive/lib/upload", () => ({ startUploads }))
vi.mock("@/features/drive/lib/uploadDirectory", () => ({ startDirectoryUpload }))

import { uploadDroppedFiles } from "@/features/drive/lib/uploadDrop"

const directory = { name: "Photos", isDirectory: true, isFile: false } as FileSystemEntry

function drop(): { dataTransfer: DataTransfer; file: File } {
	const file = new File([], "Photos")
	const dataTransfer = {
		items: [{ webkitGetAsEntry: () => directory }],
		files: [file]
	} as unknown as DataTransfer

	return { dataTransfer, file }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("uploadDroppedFiles", () => {
	it("on desktop hands the drop's top-level Files and entries to the native host, read during the drop", () => {
		const { dataTransfer, file } = drop()

		uploadDroppedFiles(dataTransfer, "parent")

		expect(startNativeDrop).toHaveBeenCalledWith([file], [directory], "parent")
		expect(startDirectoryUpload).not.toHaveBeenCalled()
	})

	it("in a browser walks a dropped directory as before", () => {
		available.mockReturnValue(false)

		uploadDroppedFiles(drop().dataTransfer, "parent")

		expect(startDirectoryUpload).toHaveBeenCalledWith({ kind: "entries", entries: [directory] }, "parent")
		expect(startNativeDrop).not.toHaveBeenCalled()
	})
})
