import { xxHash32 } from "js-xxhash"
import { type DriveItem, type CacheItem } from "@/types"

// The file-cache shape: meta carries size, created 900. `favorited` is only set when given.
export function driveFileItem(
	type: "file" | "sharedFile" | "sharedRootFile",
	uuid: string,
	name: string,
	mime: string = "application/octet-stream",
	extra?: { size?: bigint; favorited?: boolean }
): DriveItem {
	const size = extra?.size ?? 100n

	return {
		type,
		data: {
			uuid,
			decryptedMeta: {
				name,
				size,
				modified: 1000,
				created: 900,
				mime
			},
			undecryptable: false,
			size,
			...(extra?.favorited === undefined ? {} : { favorited: extra.favorited })
		}
	} as unknown as DriveItem
}

export function wrapDrive(item: DriveItem): CacheItem {
	return {
		type: "drive",
		data: item
	}
}

export function makeExternalItem(url: string, name: string): CacheItem {
	return {
		type: "external",
		data: {
			url,
			name
		}
	}
}

export function externalId(url: string): string {
	return xxHash32(url).toString(16)
}

export function extname(filename: string): string {
	const dot = filename.lastIndexOf(".")

	return dot === -1 ? "" : filename.slice(dot)
}

// The file-source shape (no meta size, created 1000) for suites resolving items through the drive cache.
export function fileSourceItems(names: { file: string; sharedFile: string; sharedRootFile: string }, mime: string) {
	function fileLike<T extends "file" | "sharedFile" | "sharedRootFile">(type: T, uuid: string, name: string, size: bigint) {
		return {
			type,
			data: {
				uuid,
				size,
				undecryptable: false,
				decryptedMeta: { name, mime, modified: 1000, created: 1000 }
			}
		}
	}

	function dirLike<T extends "directory" | "sharedDirectory">(type: T, uuid: string, name: string) {
		return {
			type,
			data: {
				uuid,
				size: 0n,
				undecryptable: false,
				decryptedMeta: { name, color: null }
			}
		}
	}

	return {
		makeFileItem: (uuid: string = "file-uuid-1") => fileLike("file", uuid, names.file, 1024n),
		makeSharedFileItem: (uuid: string = "shared-uuid-1") => fileLike("sharedFile", uuid, names.sharedFile, 512n),
		makeSharedRootFileItem: (uuid: string = "root-uuid-1") => fileLike("sharedRootFile", uuid, names.sharedRootFile, 256n),
		makeDirectoryItem: (uuid: string = "dir-uuid-1") => dirLike("directory", uuid, "my-dir"),
		makeSharedDirectoryItem: (uuid: string = "shared-dir-1") => dirLike("sharedDirectory", uuid, "shared-dir")
	}
}
