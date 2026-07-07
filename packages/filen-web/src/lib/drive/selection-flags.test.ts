import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import { aggregateDriveSelectionFlags } from "@/lib/drive/selection-flags"

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

describe("aggregateDriveSelectionFlags", () => {
	it("returns the frozen all-false, count:0 sentinel for an empty selection, by reference", () => {
		const first = aggregateDriveSelectionFlags([])
		const second = aggregateDriveSelectionFlags([])

		expect(first).toEqual({ count: 0, includesFavorited: false, everyFile: false, everyDirectory: false, includesUndecryptable: false })
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
			includesUndecryptable: false
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
			includesUndecryptable: true
		})
	})
})
