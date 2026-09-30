import { vi, describe, it, expect } from "vitest"

vi.mock("@/constants", () => ({
	EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set<string>([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".svg"]),
	EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set<string>([".mp4", ".mov", ".m4v", ".3gp", ".webm", ".mkv"]),
	EXPO_AUDIO_SUPPORTED_EXTENSIONS: new Set<string>([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"])
}))

// driveSelectors pulls in the serializer, which would otherwise load uniffi-bindgen-react-native.
vi.mock("@/lib/serializer", () => ({
	serialize: (value: unknown) => JSON.stringify(value)
}))

import { isPhotoGridItem } from "@/features/photos/utils"
import { type DriveItem } from "@/types"

function makeItem({ type, name }: { type: string; name: string | null }): DriveItem {
	return {
		type,
		data: {
			decryptedMeta: name === null ? null : { name }
		}
	} as unknown as DriveItem
}

describe("isPhotoGridItem", () => {
	it("accepts a supported image file", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "photo.jpg" }))).toBe(true)
	})

	it("accepts a video file", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "clip.mp4" }))).toBe(true)
	})

	it("accepts a RAW camera file (previewed via the SDK-extracted JPEG)", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "shot.cr2" }))).toBe(true)
	})

	it("accepts an svg (image-equivalent, renders via react-native-svg)", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "logo.svg" }))).toBe(true)
	})

	it("accepts shared file types", () => {
		expect(isPhotoGridItem(makeItem({ type: "sharedFile", name: "photo.png" }))).toBe(true)
		expect(isPhotoGridItem(makeItem({ type: "sharedRootFile", name: "photo.png" }))).toBe(true)
	})

	it("matches extensions case-insensitively", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "IMG.HEIC" }))).toBe(true)
		expect(isPhotoGridItem(makeItem({ type: "file", name: "photo.JPG" }))).toBe(true)
		expect(isPhotoGridItem(makeItem({ type: "file", name: "photo.AVIF" }))).toBe(true)
	})

	it("rejects an image whose extension expo-image cannot render", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "scan.tiff" }))).toBe(false)
	})

	it("rejects directories", () => {
		expect(isPhotoGridItem(makeItem({ type: "directory", name: "vacation.jpg" }))).toBe(false)
	})

	it("rejects items without decrypted metadata", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: null }))).toBe(false)
	})

	it("rejects non-image / non-video files", () => {
		expect(isPhotoGridItem(makeItem({ type: "file", name: "document.pdf" }))).toBe(false)
		expect(isPhotoGridItem(makeItem({ type: "file", name: "song.mp3" }))).toBe(false)
	})

	it("filters a mixed listing down to the grid items", () => {
		const items = [
			makeItem({ type: "file", name: "photo.jpg" }),
			makeItem({ type: "file", name: "clip.mp4" }),
			makeItem({ type: "file", name: "shot.dng" }),
			makeItem({ type: "directory", name: "album.jpg" }),
			makeItem({ type: "file", name: "scan.tiff" }),
			makeItem({ type: "file", name: "document.pdf" }),
			makeItem({ type: "sharedFile", name: "shared.png" }),
			makeItem({ type: "file", name: null })
		]

		expect(items.filter(isPhotoGridItem).map(item => item.data.decryptedMeta?.name)).toEqual([
			"photo.jpg",
			"clip.mp4",
			"shot.dng",
			"shared.png"
		])
	})
})
