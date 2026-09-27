import { describe, expect, it } from "vitest"
import { galleryItemFollowing, galleryItemRenderName } from "@/components/drivePreview/galleryRenderName"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"

function file(uuid: string, name: string): DriveItemFileExtracted {
	return { type: "file", data: { uuid, decryptedMeta: { name } } } as unknown as DriveItemFileExtracted
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
