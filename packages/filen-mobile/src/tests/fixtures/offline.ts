import { AnyDirWithContext, AnyNormalDir, NonRootDir_Tags, type Dir } from "@filen/sdk-rs"
import type { OfflineParent } from "@/features/offline/offlineHelpers"
import type { DriveItem } from "@/types"

// Builders for the offline store suites. They read the suite's mocked @filen/sdk-rs at runtime.

export function makeFileItem(uuid: string, name: string, size: bigint = 100n): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

export function makeDirItem(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 0n,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

export function makeParent(uuid: string): OfflineParent {
	return new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid } as unknown as Dir))
}

// Listing entries as listDirRecursiveWithPaths returns them, for the mocked sdkUnwrap stubs. Paths are
// RAW and root-relative WITHOUT a leading slash (offline.ts prefixes "/").
export function makeListingFile(uuid: string, path: string, name: string, size: bigint = 100n): { file: unknown; path: string } {
	return {
		file: {
			uuid,
			meta: {
				tag: "Decoded",
				inner: [{ name, size, modified: 1000, created: 900 }]
			}
		},
		path
	}
}

export function makeListingDir(uuid: string, path: string, name: string): { dir: unknown; path: string } {
	return {
		dir: {
			tag: NonRootDir_Tags.Normal,
			inner: [
				{
					uuid,
					meta: {
						tag: "Decoded",
						inner: [{ name }]
					}
				}
			]
		},
		path
	}
}
