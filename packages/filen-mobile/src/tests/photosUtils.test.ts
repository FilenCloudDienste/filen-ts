import { describe, it, expect } from "vitest"

import { isPhotoGridItem, filterPhotoGridItems } from "@/features/photos/utils"
import { type PreviewType } from "@/lib/previewType"
import { type DriveItem } from "@/types"
import { Paths } from "@/tests/mocks/expoFileSystem"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS } from "@/tests/mocks/constants"

// Minimal injected dependencies — kept in the test so the helper stays free of
// heavy SDK / native imports.
const supportedImageExtensions = new Set<string>([".jpg", ".jpeg", ".png", ".gif", ".heic"])

function extname(path: string): string {
	const dot = path.lastIndexOf(".")

	return dot === -1 ? "" : path.slice(dot).toLowerCase()
}

// Production-faithful extname: case-preserving (no .toLowerCase()), matching
// FileSystem.Paths.extname from expo-file-system used in production code.
function extnameProduction(path: string): string {
	return Paths.extname(path)
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

// ---------------------------------------------------------------------------
// Finding #48 — case-sensitive extension match + wrong extension set
//
// These tests inject the REAL production extname (Paths.extname — case-preserving,
// no .toLowerCase()) together with EXPO_IMAGE_SUPPORTED_EXTENSIONS (the displayable
// set, not the ImageManipulator subset).  IMG.HEIC (uppercase) and photo.avif must
// both be KEPT by the predicate after the fix.
// ---------------------------------------------------------------------------

function getPreviewTypeForFinding48(name: string): PreviewType {
	const ext = extnameProduction(name).toLowerCase()

	if ([".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp", ".avif", ".svg", ".ico", ".icns"].includes(ext)) {
		return "image"
	}

	if ([".mp4", ".mov", ".m4v", ".3gp", ".webm", ".mkv"].includes(ext)) {
		return "video"
	}

	return "unknown"
}

describe("finding #48 — case-insensitive extension + EXPO_IMAGE_SUPPORTED_EXTENSIONS", () => {
	const productionDeps = {
		getPreviewType: getPreviewTypeForFinding48,
		supportedImageExtensions: EXPO_IMAGE_SUPPORTED_EXTENSIONS,
		extname: extnameProduction
	}

	it("keeps IMG.HEIC (uppercase extension) — real production extname, displayable set", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "IMG.HEIC" }),
				...productionDeps
			})
		).toBe(true)
	})

	it("keeps photo.JPG (uppercase) — real production extname, displayable set", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "photo.JPG" }),
				...productionDeps
			})
		).toBe(true)
	})

	it("keeps photo.avif — present in EXPO_IMAGE_SUPPORTED_EXTENSIONS but absent from ImageManipulator subset", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "photo.avif" }),
				...productionDeps
			})
		).toBe(true)
	})

	it("keeps photo.AVIF (uppercase avif) — case-insensitive + displayable set", () => {
		expect(
			isPhotoGridItem({
				item: makeItem({ type: "file", name: "photo.AVIF" }),
				...productionDeps
			})
		).toBe(true)
	})

	it("filterPhotoGridItems keeps mixed-case and avif items together", () => {
		const items = [
			makeItem({ type: "file", name: "IMG.HEIC" }),
			makeItem({ type: "file", name: "photo.JPG" }),
			makeItem({ type: "file", name: "shot.avif" }),
			makeItem({ type: "file", name: "clip.mp4" }),
			makeItem({ type: "file", name: "document.pdf" })
		]

		const result = filterPhotoGridItems({
			items,
			...productionDeps
		})

		expect(result.map(item => item.data.decryptedMeta?.name)).toEqual(["IMG.HEIC", "photo.JPG", "shot.avif", "clip.mp4"])
	})
})
