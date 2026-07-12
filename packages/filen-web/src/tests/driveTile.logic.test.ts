import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { showVideoBadge } from "@/features/drive/components/driveTile.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "clip.mp4", mime: "video/mp4", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function fileItem(overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

describe("showVideoBadge", () => {
	it("is true for a video-extension file", () => {
		expect(showVideoBadge(fileItem())).toBe(true)
	})

	it("is false for a non-video file", () => {
		expect(
			showVideoBadge(
				fileItem({
					meta: {
						type: "decoded",
						data: { name: "report.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
					}
				})
			)
		).toBe(false)
	})

	it("is false for a directory", () => {
		expect(showVideoBadge(dirItem())).toBe(false)
	})

	it("agrees with previewType across every video extension it recognizes", () => {
		for (const ext of ["mp4", "webm", "mkv", "mov", "m4v"]) {
			expect(
				showVideoBadge(
					fileItem({
						meta: {
							type: "decoded",
							data: { name: `clip.${ext}`, mime: "application/octet-stream", modified: 1n, size: 1n, key: "k", version: 2 }
						}
					})
				)
			).toBe(true)
		}
	})
})
