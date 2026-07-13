import { describe, expect, it } from "vitest"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, SharingRole, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { aggregateDriveSelectionFlags, selectableForSelectAll } from "@/features/drive/lib/selectionFlags"

// UuidStr is a template-literal brand requiring at least 3 dashes — mirrors item.test.ts's own fixture.
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

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

function fileItem(overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

function undecryptableFile(overrides: Partial<File> = {}): DriveItem {
	return narrowItem({ ...mockFile(overrides), meta: { type: "encrypted", data: "ciphertext" } })
}

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockSharedRootDir(overrides: Partial<SharedRootDir> = {}): SharedRootDir {
	return {
		inner: {
			uuid: testUuid("sroot"),
			color: "default",
			timestamp: 1_700_000_000_000n,
			meta: { type: "decoded", data: { name: "SharedRoot" } }
		},
		sharingRole: sharerRole(42, "sharer@filen.io"),
		writeAccess: true,
		...overrides
	}
}

function mockSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
	return {
		uuid: testUuid("sfile"),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: sharerRole(7, "receiver@filen.io"),
		sharedTag: true,
		...overrides
	}
}

function mockSharedDir(overrides: Partial<SharedDir> = {}): SharedDir {
	return { inner: mockDir({ uuid: testUuid("sdir") }), sharedTag: true, ...overrides }
}

function sharedRootDirItem(): DriveItem {
	return narrowItem(mockSharedRootDir())
}

function sharedRootFileItem(): DriveItem {
	return narrowItem(mockSharedFile())
}

// Nested shared arms need a spread role to classify (see item.ts) — mirrors item.test.ts's own fixture.
function sharedDirItem(): DriveItem {
	return narrowItem({ ...mockSharedDir(), sharingRole: sharerRole(1, "a@filen.io") })
}

function sharedFileItem(): DriveItem {
	return narrowItem({ ...mockFile({ uuid: testUuid("nested-file") }), sharingRole: sharerRole(1, "a@filen.io") })
}

describe("aggregateDriveSelectionFlags", () => {
	it("returns the frozen all-false, count:0 sentinel for an empty selection, by reference", () => {
		const first = aggregateDriveSelectionFlags([])
		const second = aggregateDriveSelectionFlags([])

		expect(first).toEqual({
			count: 0,
			includesFavorited: false,
			everyFile: false,
			everyDirectory: false,
			includesUndecryptable: false,
			everySharedRoot: false
		})
		expect(first).toBe(second) // same frozen constant, not a freshly-built object each call
		expect(Object.isFrozen(first)).toBe(true)
	})

	it("counts the selection", () => {
		const flags = aggregateDriveSelectionFlags([dirItem({ uuid: testUuid("a") }), fileItem({ uuid: testUuid("b") })])

		expect(flags.count).toBe(2)
	})

	it("includesFavorited is true when any selected item is favorited", () => {
		const flags = aggregateDriveSelectionFlags([
			dirItem({ uuid: testUuid("a"), favorited: false }),
			fileItem({ uuid: testUuid("b"), favorited: true })
		])

		expect(flags.includesFavorited).toBe(true)
	})

	it("includesFavorited is false when nothing selected is favorited", () => {
		const flags = aggregateDriveSelectionFlags([
			dirItem({ uuid: testUuid("a"), favorited: false }),
			fileItem({ uuid: testUuid("b"), favorited: false })
		])

		expect(flags.includesFavorited).toBe(false)
	})

	it("everyDirectory is true and everyFile is false when the whole selection is directories", () => {
		const flags = aggregateDriveSelectionFlags([dirItem({ uuid: testUuid("a") }), dirItem({ uuid: testUuid("b") })])

		expect(flags.everyDirectory).toBe(true)
		expect(flags.everyFile).toBe(false)
	})

	it("everyFile is true and everyDirectory is false when the whole selection is files", () => {
		const flags = aggregateDriveSelectionFlags([fileItem({ uuid: testUuid("a") }), fileItem({ uuid: testUuid("b") })])

		expect(flags.everyFile).toBe(true)
		expect(flags.everyDirectory).toBe(false)
	})

	it("a mixed file+directory selection has both everyFile and everyDirectory false", () => {
		const flags = aggregateDriveSelectionFlags([dirItem({ uuid: testUuid("a") }), fileItem({ uuid: testUuid("b") })])

		expect(flags.everyFile).toBe(false)
		expect(flags.everyDirectory).toBe(false)
	})

	it("includesUndecryptable is true when any selected item is undecryptable", () => {
		const flags = aggregateDriveSelectionFlags([fileItem({ uuid: testUuid("a") }), undecryptableFile({ uuid: testUuid("b") })])

		expect(flags.includesUndecryptable).toBe(true)
	})

	it("includesUndecryptable is false when nothing selected is undecryptable", () => {
		const flags = aggregateDriveSelectionFlags([fileItem({ uuid: testUuid("a") }), dirItem({ uuid: testUuid("b") })])

		expect(flags.includesUndecryptable).toBe(false)
	})

	it("a single-item directory selection is every{Directory,File} correctly (true/false, not vacuously both)", () => {
		const flags = aggregateDriveSelectionFlags([dirItem({ uuid: testUuid("a") })])

		expect(flags).toEqual({
			count: 1,
			includesFavorited: false,
			everyFile: false,
			everyDirectory: true,
			includesUndecryptable: false,
			everySharedRoot: false
		})
	})

	it("a fully-mixed selection (favorited dir, undecryptable file) aggregates every flag independently in one pass", () => {
		const flags = aggregateDriveSelectionFlags([
			dirItem({ uuid: testUuid("a"), favorited: true }),
			undecryptableFile({ uuid: testUuid("b") })
		])

		expect(flags).toEqual({
			count: 2,
			includesFavorited: true,
			everyFile: false,
			everyDirectory: false,
			includesUndecryptable: true,
			everySharedRoot: false
		})
	})
})

describe("aggregateDriveSelectionFlags — everySharedRoot", () => {
	it("is true when the whole selection is shared-root arms (sharedRootDirectory/sharedRootFile)", () => {
		const flags = aggregateDriveSelectionFlags([sharedRootDirItem(), sharedRootFileItem()])

		expect(flags.everySharedRoot).toBe(true)
	})

	it("is true for a single-item shared-root selection (true/false, not vacuously true)", () => {
		const flags = aggregateDriveSelectionFlags([sharedRootDirItem()])

		expect(flags.everySharedRoot).toBe(true)
	})

	it("is false when a shared-root item is mixed with an owned item", () => {
		const flags = aggregateDriveSelectionFlags([sharedRootDirItem(), dirItem({ uuid: testUuid("owned") })])

		expect(flags.everySharedRoot).toBe(false)
	})

	it("is false for nested shared arms (sharedDirectory/sharedFile) — everySharedRoot keys on item.type, not on shareSource", () => {
		const flags = aggregateDriveSelectionFlags([sharedDirItem(), sharedFileItem()])

		expect(flags.everySharedRoot).toBe(false)
	})

	it("is false for a plain owned selection", () => {
		const flags = aggregateDriveSelectionFlags([dirItem({ uuid: testUuid("a") }), fileItem({ uuid: testUuid("b") })])

		expect(flags.everySharedRoot).toBe(false)
	})
})

describe("selectableForSelectAll — the select-all set", () => {
	it("drops undecryptable items, keeping every decryptable one in order", () => {
		const a = dirItem({ uuid: testUuid("a") })
		const enc = undecryptableFile({ uuid: testUuid("enc") })
		const b = fileItem({ uuid: testUuid("b") })

		expect(selectableForSelectAll([a, enc, b])).toEqual([a, b])
	})

	it("returns an empty array when every item is undecryptable", () => {
		expect(selectableForSelectAll([undecryptableFile({ uuid: testUuid("x") }), undecryptableFile({ uuid: testUuid("y") })])).toEqual([])
	})

	it("passes a fully-decryptable selection through unchanged", () => {
		const items = [dirItem({ uuid: testUuid("a") }), fileItem({ uuid: testUuid("b") })]

		expect(selectableForSelectAll(items)).toEqual(items)
	})
})
