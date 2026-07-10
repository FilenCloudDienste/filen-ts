import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { previewCategoryForName } from "@/features/drive/lib/preview.logic"
import {
	type PreviewSource,
	drivePreviewSources,
	previewSourceKey,
	previewSourceName,
	stepPreviewSourceIndex
} from "@/features/preview/lib/previewSource"

// Branded UuidStr fixture — see preview.logic.test.ts's own testUuid for why the cast is required.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function fileNamed(name: string, uuid: UuidStr = testUuid(name)): DriveItem {
	return narrowItem({
		uuid,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	} satisfies File)
}

function externalSource(url: string, name: string): PreviewSource {
	return { type: "external", url, name }
}

describe("drivePreviewSources", () => {
	it("wraps each drive item in the drive arm, preserving order and item identity", () => {
		const a = fileNamed("a.png")
		const b = fileNamed("b.mp4")
		const sources = drivePreviewSources([a, b])

		expect(sources).toHaveLength(2)
		expect(sources[0]).toEqual({ type: "drive", item: a })
		expect(sources[1]).toEqual({ type: "drive", item: b })
		// Same object reference, not a clone — the drive arm is a pure tag over the frozen snapshot.
		expect(sources[0]?.type === "drive" && sources[0].item).toBe(a)
	})

	it("is empty for an empty list", () => {
		expect(drivePreviewSources([])).toEqual([])
	})
})

describe("previewSourceKey — union narrowing", () => {
	it("keys a drive source by its item uuid", () => {
		const item = fileNamed("doc.pdf", testUuid("doc"))

		expect(previewSourceKey({ type: "drive", item })).toBe(item.data.uuid)
	})

	it("keys an external source by its url", () => {
		expect(previewSourceKey(externalSource("https://example.com/a.png", "a.png"))).toBe("https://example.com/a.png")
	})
})

describe("previewSourceName — union narrowing", () => {
	it("names a drive source by its decrypted name", () => {
		expect(previewSourceName({ type: "drive", item: fileNamed("photo.jpg") })).toBe("photo.jpg")
	})

	it("names an external source by its own name", () => {
		expect(previewSourceName(externalSource("https://example.com/x", "clip.mp4"))).toBe("clip.mp4")
	})
})

describe("stepPreviewSourceIndex — mixed-arm stepping", () => {
	const sources: PreviewSource[] = [
		{ type: "drive", item: fileNamed("a.png", testUuid("a")) },
		externalSource("https://example.com/b.mp4", "b.mp4"),
		{ type: "drive", item: fileNamed("c.pdf", testUuid("c")) }
	]

	it("steps forward from the current key", () => {
		expect(stepPreviewSourceIndex(testUuid("a"), sources, 1)).toBe(1)
	})

	it("steps backward from the current key", () => {
		expect(stepPreviewSourceIndex(testUuid("c"), sources, -1)).toBe(1)
	})

	it("resolves an external source by its url key", () => {
		expect(stepPreviewSourceIndex("https://example.com/b.mp4", sources, 1)).toBe(2)
	})

	it("clamps at the ends (no wrap)", () => {
		expect(stepPreviewSourceIndex(testUuid("a"), sources, -1)).toBe(0)
		expect(stepPreviewSourceIndex(testUuid("c"), sources, 1)).toBe(2)
	})

	it("steps from the start when the key is unresolvable", () => {
		expect(stepPreviewSourceIndex("missing", sources, 1)).toBe(1)
	})
})

// The external arm's viewer routing is driven entirely by this category resolution (image ->
// ZoomableImage, video/audio -> MediaElement, everything else -> the unsupported state).
describe("previewCategoryForName — external-arm routing", () => {
	it.each(["png", "jpg", "webp", "gif", "svg", "heic"])("%s routes to the image viewer", ext => {
		expect(previewCategoryForName(`a.${ext}`)).toBe("image")
	})

	it.each(["mp4", "webm", "mkv", "mov"])("%s routes to the media (video) viewer", ext => {
		expect(previewCategoryForName(`a.${ext}`)).toBe("video")
	})

	it.each(["mp3", "flac", "wav", "ogg"])("%s routes to the media (audio) viewer", ext => {
		expect(previewCategoryForName(`a.${ext}`)).toBe("audio")
	})

	it.each(["pdf", "docx", "md", "txt", "ts"])("%s falls to the unsupported state (no external viewer)", ext => {
		// Every non-media category is unrenderable on the external arm — only image/video/audio load
		// natively from a bare url; the rest show the standard unsupported state.
		const category = previewCategoryForName(`a.${ext}`)

		expect(category).not.toBe("image")
		expect(category).not.toBe("video")
		expect(category).not.toBe("audio")
	})

	it("resolves an unknown extension to other", () => {
		expect(previewCategoryForName("a.xyz")).toBe("other")
		expect(previewCategoryForName("noextension")).toBe("other")
	})
})
