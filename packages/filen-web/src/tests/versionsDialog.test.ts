import { describe, expect, it } from "vitest"
import type { File, FileVersion } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import type { FileItem } from "@/features/drive/lib/actions"
import { isCurrentVersion, nonCurrentVersions } from "@/features/drive/components/versionsDialog.logic"
import { testUuid } from "@/tests/support/uuid"

// Local fixtures mirror actions.test.ts's own per-file convention.
function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		stableUUID: undefined,
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
		// The FILE's whole-life id, identical for every version of it — never the version's own uuid.
		stableUUID: testUuid("file"),
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

describe("nonCurrentVersions", () => {
	it("excludes the live version, keeping every historical one", () => {
		const file = fileItem({ uuid: testUuid("current") })
		const current = mockVersion({ uuid: testUuid("current") })
		const older = mockVersion({ uuid: testUuid("older") })
		const oldest = mockVersion({ uuid: testUuid("oldest") })

		expect(nonCurrentVersions([current, older, oldest], file).map(v => v.uuid)).toEqual([testUuid("older"), testUuid("oldest")])
	})

	it("returns an empty array when the only version present is the current one", () => {
		const file = fileItem({ uuid: testUuid("same") })
		const version = mockVersion({ uuid: testUuid("same") })

		expect(nonCurrentVersions([version], file)).toEqual([])
	})
})
