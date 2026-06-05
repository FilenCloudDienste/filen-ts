import { describe, it, expect } from "vitest"

import { isPhotoGridItem, filterPhotoGridItems } from "@/features/photos/utils"
import { type PreviewType } from "@/lib/previewType"
import { type DriveItem } from "@/types"

// Minimal injected dependencies — kept in the test so the helper stays free of
// heavy SDK / native imports.
const supportedImageExtensions = new Set<string>([".jpg", ".jpeg", ".png", ".gif", ".heic"])

function extname(path: string): string {
	const dot = path.lastIndexOf(".")

	return dot === -1 ? "" : path.slice(dot).toLowerCase()
}

function getPreviewType(name: string): PreviewType {
	const ext = extname(name)

	if ([".jpg", ".jpeg", ".png", ".gif", ".heic", ".tiff"].includes(ext)) {
		return "image"
	}

	if ([".mp4", ".mov", ".mkv"].includes(ext)) {
		return "video"
	}

	if (ext === ".pdf") {
		return "pdf"
	}

	return "unknown"
}

function makeItem({ type, name }: { type: string; name: string | null }): DriveItem {
	return {
		type,
		data: {
			decryptedMeta: name === null ? null : { name }
		}
	} as unknown as DriveItem
}

const deps = {
	getPreviewType,
	supportedImageExtensions,
	extname
}

describe("isPhotoGridItem", () => {
	it("accepts a supported image file", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "photo.jpg" }),
				...deps
			})
		).toBe(true)
	})

	it("accepts a video file regardless of the supported-image set", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "clip.mp4" }),
				...deps
			})
		).toBe(true)
	})

	it("accepts shared file types", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "sharedFile", name: "photo.png" }),
				...deps
			})
		).toBe(true)
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "sharedRootFile", name: "photo.png" }),
				...deps
			})
		).toBe(true)
	})

	it("rejects an image whose extension is not in the supported set", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "scan.tiff" }),
				...deps
			})
		).toBe(false)
	})

	it("rejects directories", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "directory", name: "vacation.jpg" }),
				...deps
			})
		).toBe(false)
	})

	it("rejects items without decrypted metadata", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: null }),
				...deps
			})
		).toBe(false)
	})

	it("rejects non-image / non-video files", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "document.pdf" }),
				...deps
			})
		).toBe(false)
	})
})

describe("filterPhotoGridItems", () => {
	it("keeps only supported photo-grid items", () => {
		const items = [
			makeItem({ type: "file", name: "photo.jpg" }),
			makeItem({ type: "file", name: "clip.mp4" }),
			makeItem({ type: "directory", name: "album.jpg" }),
			makeItem({ type: "file", name: "scan.tiff" }),
			makeItem({ type: "file", name: "document.pdf" }),
			makeItem({ type: "sharedFile", name: "shared.png" }),
			makeItem({ type: "file", name: null })
		]

		const result = filterPhotoGridItems({
			items,
			...deps
		})

		expect(result.map(item => item.data.decryptedMeta?.name)).toEqual(["photo.jpg", "clip.mp4", "shared.png"])
	})

	it("returns an empty array when nothing matches", () => {
		const items = [makeItem({ type: "directory", name: "album" }), makeItem({ type: "file", name: "document.pdf" })]

		expect(
			filterPhotoGridItems({
				items,
				...deps
			})
		).toEqual([])
	})
})
