import type { AnyNormalDir, File } from "@filen/sdk-rs"
import type { ExtractFailure } from "@filen/shared"
import { createWebCompressJob, createWebExtractJob, type CompressJob, type ExtractJob } from "@/features/drive/lib/archiveJobs.logic"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { testUuid } from "@/tests/support/uuid"

// Compress and extract jobs as the runners create them, for the card, toast and dialog tests.

export const JOB_DESTINATION = { uuid: null, name: "Photos" }

export const ARCHIVE_FILE: File = {
	uuid: testUuid("archive"),
	stableUUID: undefined,
	parent: testUuid("root"),
	size: 1_000n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "photos.zip", mime: "application/zip", modified: 0n, size: 1_000n, key: "k", version: 2 } }
}

export function compressJob(overrides: Partial<CompressJob> = {}, id = "job"): CompressJob {
	return {
		...createWebCompressJob({
			id,
			source: { kind: "items", items: [] },
			destination: JOB_DESTINATION,
			name: "photos.zip",
			format: { type: "zip", method: { type: "deflate", level: 6 } },
			encrypted: false,
			dispose: null,
			itemCount: 3
		}),
		...overrides
	}
}

export function extractJob(overrides: Partial<ExtractJob> = {}, id = "job"): ExtractJob {
	return {
		...createWebExtractJob({
			id,
			archive: { file: ARCHIVE_FILE, uuid: ARCHIVE_FILE.uuid, name: "photos.zip" },
			destination: JOB_DESTINATION,
			root: { type: "newFolder" },
			rowName: "photos",
			calls: [{ type: "all" }],
			skipMacMetadata: true,
			dispose: null,
			basis: { type: "archiveRead" },
			formatHint: "zip",
			glyph: "directory"
		}),
		...overrides
	}
}

export function extractFailure(path: string, index: number, error: ErrorDTO): ExtractFailure<AnyNormalDir, ErrorDTO> {
	return {
		entry: { archive: ARCHIVE_FILE.uuid, index },
		path,
		destParent: testUuid("dest"),
		destName: path,
		stage: { type: "upload" },
		retry: { destination: testUuid("dest"), destinationDir: { uuid: testUuid("dest") }, base: "" },
		error
	}
}

export function createdDirectory(name: string): DriveItem {
	return narrowItem({
		uuid: testUuid(name),
		parent: testUuid("root"),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	})
}

// The archive itself as an item, as a compress registers it.
export const ARCHIVE_ITEM: DriveItem = narrowItem(ARCHIVE_FILE)
