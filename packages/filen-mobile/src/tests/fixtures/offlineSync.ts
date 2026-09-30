import type { OfflineParent } from "@/features/offline/offlineHelpers"
import type { DriveItem } from "@/types"

// Builders for the offline sync suites: stored trees and parents as the offline metas hold them, and
// remote SDK shapes for the mocked sdkUnwrap stubs.

export function uuidParent(uuid: string): { tag: "Uuid"; inner: [string] } {
	return {
		tag: "Uuid",
		inner: [uuid]
	}
}

// Stored tree root (own cloud): a "directory" DriveItem with a ParentUuid-shaped data.parent.
export function makeTreeItem(uuid: string, name: string, parentUuid: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			parent: uuidParent(parentUuid),
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

export function makeFileItem(uuid: string, name: string, size: bigint = 100n): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			parent: uuidParent("parent-1"),
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

// Plain tagged-union literal: parentCacheKey and the listing switch only read tags and inner fields.
export function makeNormalParent(uuid: string): OfflineParent {
	return {
		tag: "Normal",
		inner: [
			{
				tag: "Dir",
				inner: [
					{
						uuid
					}
				]
			}
		]
	} as unknown as OfflineParent
}

// Remote SDK Dir as getDirOptional and the listings return it.
export function makeRemoteDir(uuid: string, name: string, parent: unknown): unknown {
	return {
		uuid,
		parent,
		meta: {
			tag: "Decoded",
			inner: [
				{
					name
				}
			]
		}
	}
}
