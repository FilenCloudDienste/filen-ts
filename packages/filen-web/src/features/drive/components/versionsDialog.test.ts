import { describe, expect, it } from "vitest"
import type { File, FileVersion, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import type { FileItem } from "@/features/drive/lib/actions"
import { hasNoPreviousVersions, isCurrentVersion } from "@/features/drive/components/versionsDialog.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring actions.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Local fixtures mirror actions.test.ts's own per-file convention.
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

function fileItem(overrides: Partial<File> = {}): FileItem {
	const item = narrowItem(mockFile(overrides))
	if (item.type !== "file") {
		throw new Error("expected a file arm")
	}
	return item
}

function mockVersion(overrides: Partial<FileVersion> = {}): FileVersion {
	return {
		bucket: "filen-1",
		region: "de-1",
		chunks: 1n,
		size: 512n,
		metadata: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_600_000_000_000n, size: 512n, key: "old-key", version: 2 }
		},
		timestamp: 1_600_000_000_000n,
		uuid: testUuid("version"),
		...overrides
	}
}

describe("isCurrentVersion", () => {
	it("is true when the version's uuid matches the file's own (live) uuid", () => {
		const file = fileItem({ uuid: testUuid("same") })
		const version = mockVersion({ uuid: testUuid("same") })
		expect(isCurrentVersion(version, file)).toBe(true)
	})

	it("is false for a historical version whose uuid differs from the file's current one", () => {
		const file = fileItem({ uuid: testUuid("current") })
		const version = mockVersion({ uuid: testUuid("older") })
		expect(isCurrentVersion(version, file)).toBe(false)
	})
})

describe("hasNoPreviousVersions", () => {
	it("is true when the only version present is the current (live) one", () => {
		const file = fileItem({ uuid: testUuid("same") })
		const version = mockVersion({ uuid: testUuid("same") })
		expect(hasNoPreviousVersions([version], file)).toBe(true)
	})

	it("is true for an empty list (defensive — the SDK is not expected to ever return this)", () => {
		const file = fileItem()
		expect(hasNoPreviousVersions([], file)).toBe(true)
	})

	it("is false once at least one historical version sits alongside the current one", () => {
		const file = fileItem({ uuid: testUuid("current") })
		const current = mockVersion({ uuid: testUuid("current") })
		const older = mockVersion({ uuid: testUuid("older") })
		expect(hasNoPreviousVersions([current, older], file)).toBe(false)
	})
})
