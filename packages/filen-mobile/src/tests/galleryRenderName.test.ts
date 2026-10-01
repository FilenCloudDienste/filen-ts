import { describe, expect, it, vi } from "vitest"

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import {
	galleryItemFollowing,
	galleryItemPreviewType,
	galleryItemRenderName,
	galleryItemTypeExtension
} from "@/components/drivePreview/galleryRenderName"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"

function file(uuid: string, name: string, mime?: string): DriveItemFileExtracted {
	return { type: "file", data: { uuid, decryptedMeta: { name, mime } } } as unknown as DriveItemFileExtracted
}

describe("a gallery page's render name", () => {
	it("is the file's own name until the file is replaced", () => {
		expect(galleryItemRenderName({ type: "drive", data: file("v1", "todo.txt") })).toBe("todo.txt")
	})

	it("keeps the name the page opened with across a rename, so an open editor is never swapped out", () => {
		const opened: GalleryItemTagged = { type: "drive", data: file("v1", "todo.txt") }
		const renamed = galleryItemFollowing(opened, file("v1", "todo"))

		expect(renamed.type === "drive" ? renamed.data.data.decryptedMeta?.name : undefined).toBe("todo")
		expect(galleryItemRenderName(renamed)).toBe("todo.txt")
		// A save or newer version after it keeps it too.
		expect(galleryItemRenderName(galleryItemFollowing(renamed, file("v2", "todo.bak")))).toBe("todo.txt")
	})
})

describe("a gallery page's renderer", () => {
	it("reads the render name, then the file's stored mime", () => {
		expect(galleryItemPreviewType({ type: "drive", data: file("v1", "clip", "video/mp4") })).toBe("video")
		expect(galleryItemPreviewType({ type: "drive", data: file("v1", "Makefile") })).toBe("code")
		expect(galleryItemPreviewType({ type: "drive", data: file("v1", "data.bin", "application/octet-stream") })).toBe("unknown")
	})

	it("is the text viewer for a file opened as text, whatever its type", () => {
		expect(galleryItemPreviewType({ type: "drive", data: file("v1", "data.bin"), asText: true })).toBe("text")
		expect(galleryItemPreviewType({ type: "drive", data: file("v1", "photo.jpg"), asText: true })).toBe("text")
	})

	it("stays the text viewer across a rename or a newer version", () => {
		const opened: GalleryItemTagged = { type: "drive", data: file("v1", "data.bin"), asText: true }
		const followed = galleryItemFollowing(opened, file("v2", "data.dat"))

		expect(followed).toMatchObject({ asText: true })
		expect(galleryItemPreviewType(followed)).toBe("text")
		expect(galleryItemFollowing({ type: "drive", data: file("v1", "a.txt") }, file("v2", "a.txt"))).not.toHaveProperty("asText")
	})

	it("picks the editor mode by the type extension, plain for a file opened as text", () => {
		expect(galleryItemTypeExtension({ type: "drive", data: file("v1", ".bashrc") })).toBe("sh")
		expect(galleryItemTypeExtension({ type: "drive", data: file("v1", "README.MD") })).toBe("md")
		expect(galleryItemTypeExtension({ type: "drive", data: file("v1", "data.bin"), asText: true })).toBe("")
	})
})
