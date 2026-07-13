import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	isPhotosChooserConfirmDisabled,
	isPhotosChooserRowDisabled,
	photosChooserDirectories
} from "@/features/photos/components/directoryChooserDialog.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short readable test label
// into a shape that satisfies it, mirroring moveTargetDialog.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function dirItem(uuid: string, overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir({ uuid: testUuid(uuid), ...overrides }))
}

function fileItem(uuid: string, overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile({ uuid: testUuid(uuid), ...overrides }))
}

describe("photosChooserDirectories (chooser gating: non-writable/non-directory targets excluded)", () => {
	it("keeps directory rows and drops file rows from the same listing", () => {
		const rows = [dirItem("a"), fileItem("b"), dirItem("c")]

		expect(photosChooserDirectories(rows).map(row => row.data.uuid)).toEqual([testUuid("a"), testUuid("c")])
	})

	it("returns an empty array when the listing has no directories at all", () => {
		expect(photosChooserDirectories([fileItem("a"), fileItem("b")])).toEqual([])
	})
})

describe("isPhotosChooserRowDisabled", () => {
	it("disables an undecryptable directory row (no name to show, unresolvable as a root)", () => {
		const undecryptable = narrowItem({
			uuid: testUuid("locked"),
			parent: testUuid("parent"),
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "encrypted", data: "ciphertext" }
		})

		expect(isPhotosChooserRowDisabled(undecryptable)).toBe(true)
	})

	it("enables an ordinary decryptable directory row", () => {
		expect(isPhotosChooserRowDisabled(dirItem("a"))).toBe(false)
	})
})

describe("isPhotosChooserConfirmDisabled", () => {
	it("is disabled while still browsing at the drive root (no directory opened yet)", () => {
		expect(isPhotosChooserConfirmDisabled(null)).toBe(true)
	})

	it("is enabled once a directory has been opened", () => {
		expect(isPhotosChooserConfirmDisabled(testUuid("a"))).toBe(false)
	})
})
