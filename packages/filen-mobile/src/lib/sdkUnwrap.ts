import {
	type File,
	type Dir,
	type DecryptedFileMeta,
	FileMeta_Tags,
	DirMeta_Tags,
	type DecryptedDirMeta,
	type SharedDir,
	type SharedFile,
	ParentUuid_Tags,
	ParentUuid,
	type SharedRootDir,
	SharingRole,
	AnyDirWithContext,
	AnyDirWithContext_Tags,
	AnyNormalDir_Tags,
	AnyNormalDir,
	AnySharedDir,
	AnyFile,
	AnyFile_Tags,
	type LinkedFile,
	FileMeta,
	MaybeEncryptedUniffi_Tags
} from "@filen/sdk-rs"
import { FILE_PUBLIC_LINK_URL_PREFIX, DIRECTORY_PUBLIC_LINK_URL_PREFIX } from "@/constants"
import type { DriveItem } from "@/types"
import { type Prettify } from "@filen/shared"
import cache from "@/lib/cache"
import type { DrivePath } from "@/hooks/useDrivePath"

export function unwrapAnyDirUuid(dir: AnyDirWithContext): string | null {
	switch (dir.tag) {
		case AnyDirWithContext_Tags.Linked:
		case AnyDirWithContext_Tags.Shared: {
			return dir.inner[0].dir.inner[0].inner.uuid
		}

		case AnyDirWithContext_Tags.Normal: {
			return dir.inner[0].inner[0].uuid
		}

		default: {
			return null
		}
	}
}

export function unwrapParentUuid(parent: ParentUuid): string | null {
	switch (parent.tag) {
		case ParentUuid_Tags.Uuid: {
			return parent.inner[0]
		}

		default: {
			return null
		}
	}
}

// Only own files and directories have a parent listing; shared variants resolve to null.
export function normalParentUuidOf(item: DriveItem): string | null {
	return item.type === "file" || item.type === "directory" ? unwrapParentUuid(item.data.parent) : null
}

// The generated bindings model an item's parent as the ParentUuid tagged enum: Uuid(uuid) for a
// real parent directory plus the unit variants Trash/Recents/Favorites/Links. getDirOptional /
// getFileOptional return trashed items with parent = ParentUuid.Trash (permanently deleted items
// resolve to undefined instead), so this single tag check is the trash discriminator for both Dir
// and File lookup results.
export function isTrashParent(parent: ParentUuid): boolean {
	return parent.tag === ParentUuid_Tags.Trash
}

export type UnwrapDirMetaBase = {
	meta: DecryptedDirMeta | null
	uuid: string
	undecryptable: boolean
}

export type UnwrapDirMetaNormal = UnwrapDirMetaBase & {
	shared: false
	dir: Dir
}

export type UnwrapDirMetaShared = UnwrapDirMetaBase & {
	shared: true
	root: false
	sharedTag: boolean
	dir: SharedDir
}

export type UnwrapDirMetaSharedRoot = UnwrapDirMetaBase & {
	shared: true
	root: true
	dir: SharedRootDir
	sharingRole: SharingRole
}

export type UnwrapDirMetaResult = UnwrapDirMetaNormal | UnwrapDirMetaShared | UnwrapDirMetaSharedRoot

export function unwrapDirMeta(dir: Dir | SharedDir | SharedRootDir | AnyDirWithContext | AnyNormalDir | AnySharedDir): UnwrapDirMetaResult {
	if (AnyDirWithContext.instanceOf(dir)) {
		switch (dir.tag) {
			case AnyDirWithContext_Tags.Linked: {
				throw new Error(`Unsupported AnyDirWithContext tag: ${dir.tag}`)
			}

			case AnyDirWithContext_Tags.Shared: {
				return unwrapDirMeta(dir.inner[0].dir.inner[0])
			}

			case AnyDirWithContext_Tags.Normal: {
				switch (dir.inner[0].tag) {
					case AnyNormalDir_Tags.Dir: {
						return unwrapDirMeta(dir.inner[0].inner[0])
					}

					default: {
						throw new Error(`Unsupported AnyNormalDir tag: ${dir.inner[0].tag}`)
					}
				}
			}
		}
	}

	if (AnyNormalDir.instanceOf(dir)) {
		switch (dir.tag) {
			case AnyNormalDir_Tags.Dir: {
				return unwrapDirMeta(dir.inner[0])
			}

			default: {
				throw new Error(`Unsupported AnyNormalDir tag: ${dir.tag}`)
			}
		}
	}

	if (AnySharedDir.instanceOf(dir)) {
		return unwrapDirMeta(dir.inner[0])
	}

	if ("uuid" in dir) {
		const meta = dir.meta.tag === DirMeta_Tags.Decoded ? dir.meta.inner[0] : null

		return {
			meta,
			shared: false,
			dir,
			uuid: dir.uuid,
			undecryptable: meta === null
		}
	}

	const meta = dir.inner.meta.tag === DirMeta_Tags.Decoded ? dir.inner.meta.inner[0] : null

	if ("sharedTag" in dir) {
		return {
			meta,
			shared: true,
			root: false,
			sharedTag: dir.sharedTag,
			dir,
			uuid: dir.inner.uuid,
			undecryptable: meta === null
		}
	}

	return {
		meta,
		shared: true,
		root: true,
		sharingRole: dir.sharingRole,
		dir,
		uuid: dir.inner.uuid,
		undecryptable: meta === null
	}
}

export function unwrappedDirIntoDriveItem(unwrappedDir: ReturnType<typeof unwrapDirMeta>): DriveItem {
	if (unwrappedDir.shared) {
		if (unwrappedDir.root) {
			return {
				type: "sharedRootDirectory",
				data: {
					...unwrappedDir.dir,
					size: 0n,
					decryptedMeta: unwrappedDir.meta,
					uuid: unwrappedDir.uuid,
					undecryptable: unwrappedDir.undecryptable
				}
			}
		}

		return {
			type: "sharedDirectory",
			data: {
				...unwrappedDir.dir,
				size: 0n,
				decryptedMeta: unwrappedDir.meta,
				uuid: unwrappedDir.uuid,
				undecryptable: unwrappedDir.undecryptable
			}
		}
	}

	return {
		type: "directory",
		data: {
			...unwrappedDir.dir,
			size: 0n,
			decryptedMeta: unwrappedDir.meta,
			undecryptable: unwrappedDir.undecryptable
		}
	}
}

export type UnwrapFileMetaBase = {
	meta: DecryptedFileMeta | null
	undecryptable: boolean
}

export type UnwrapFileMetaRegular = Prettify<
	UnwrapFileMetaBase & {
		shared: false
		root: false
		file: File
	}
>

export type UnwrapFileMetaShared = Prettify<
	UnwrapFileMetaBase & {
		shared: true
		root: false
		file: Prettify<File & SharedFile>
	}
>

export type UnwrapFileMetaSharedRoot = Prettify<
	UnwrapFileMetaBase & {
		shared: true
		root: true
		file: SharedFile
	}
>

export type UnwrapFileMetaResult = UnwrapFileMetaRegular | UnwrapFileMetaShared | UnwrapFileMetaSharedRoot

export function unwrapFileMeta(
	file:
		| File
		| SharedFile
		| AnyFile
		| (File & {
				sharingRole: SharingRole
		  })
): UnwrapFileMetaResult {
	if (AnyFile.instanceOf(file)) {
		switch (file.tag) {
			case AnyFile_Tags.File:
			case AnyFile_Tags.Shared: {
				return unwrapFileMeta(file.inner[0])
			}

			default: {
				throw new Error(`Unsupported AnyFile tag: ${file.tag}`)
			}
		}
	}

	const meta = file.meta.tag === FileMeta_Tags.Decoded ? file.meta.inner[0] : null

	if (!("favorited" in file)) {
		return {
			meta,
			shared: true,
			root: true,
			file,
			undecryptable: meta === null
		}
	}

	if ("sharingRole" in file) {
		return {
			meta,
			shared: true,
			root: false,
			file: {
				...file,
				sharedTag: true
			},
			undecryptable: meta === null
		}
	}

	return {
		meta,
		shared: false,
		root: false,
		file,
		undecryptable: meta === null
	}
}

export function unwrappedFileIntoDriveItem(unwrappedFile: ReturnType<typeof unwrapFileMeta>): DriveItem {
	if (unwrappedFile.shared) {
		if (unwrappedFile.root) {
			return {
				type: "sharedRootFile",
				data: {
					...unwrappedFile.file,
					size: unwrappedFile.meta?.size ?? 0n,
					decryptedMeta: unwrappedFile.meta,
					uuid: unwrappedFile.file.uuid,
					undecryptable: unwrappedFile.undecryptable
				}
			}
		}

		return {
			type: "sharedFile",
			data: {
				...unwrappedFile.file,
				size: unwrappedFile.meta?.size ?? 0n,
				decryptedMeta: unwrappedFile.meta,
				uuid: unwrappedFile.file.uuid,
				undecryptable: unwrappedFile.undecryptable
			}
		}
	}

	return {
		type: "file",
		data: {
			...unwrappedFile.file,
			decryptedMeta: unwrappedFile.meta,
			undecryptable: unwrappedFile.undecryptable
		}
	}
}

// Gets the real parent of a drive item.
// For shared out items, this will be the parent in the users normal drive structure since that's where the item actually lives, even though the sdk may return a shared directory as the parent since it's a shared out item.
export function getRealDriveItemParent({
	item,
	drivePath
}: {
	item: DriveItem
	drivePath: DrivePath
}): AnyDirWithContext | "sharedInRoot" | null {
	switch (item.type) {
		case "directory":
		case "file": {
			const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

			if (unwrappedParentUuid) {
				if (cache.rootUuid && unwrappedParentUuid === cache.rootUuid) {
					return new AnyDirWithContext.Normal(
						new AnyNormalDir.Root({
							uuid: cache.rootUuid
						})
					)
				}

				const fromCache = cache.directoryUuidToAnyNormalDir.get(unwrappedParentUuid)

				if (fromCache) {
					return new AnyDirWithContext.Normal(fromCache)
				}
			}

			return null
		}

		case "sharedDirectory": {
			const unwrappedParentUuid = unwrapParentUuid(item.data.inner.parent)

			if (unwrappedParentUuid) {
				if (drivePath.type === "sharedIn") {
					const fromCache = cache.directoryUuidToAnySharedDirWithContext.get(unwrappedParentUuid)

					if (fromCache) {
						return new AnyDirWithContext.Shared(fromCache)
					}
				}

				// We can use the users normal drive cache here since it's a shared out item that they are sharing, it belongs to their normal drive structure
				if (drivePath.type === "sharedOut") {
					if (cache.rootUuid && unwrappedParentUuid === cache.rootUuid) {
						return new AnyDirWithContext.Normal(
							new AnyNormalDir.Root({
								uuid: cache.rootUuid
							})
						)
					}

					const fromCache = cache.directoryUuidToAnyNormalDir.get(unwrappedParentUuid)

					if (fromCache) {
						return new AnyDirWithContext.Normal(fromCache)
					}
				}
			}

			return null
		}

		case "sharedFile": {
			const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

			if (unwrappedParentUuid) {
				if (drivePath.type === "sharedIn") {
					const fromCache = cache.directoryUuidToAnySharedDirWithContext.get(unwrappedParentUuid)

					if (fromCache) {
						return new AnyDirWithContext.Shared(fromCache)
					}
				}

				// We can use the users normal drive cache here since it's a shared out item that they are sharing, it belongs to their normal drive structure
				if (drivePath.type === "sharedOut") {
					if (cache.rootUuid && unwrappedParentUuid === cache.rootUuid) {
						return new AnyDirWithContext.Normal(
							new AnyNormalDir.Root({
								uuid: cache.rootUuid
							})
						)
					}

					const fromCache = cache.directoryUuidToAnyNormalDir.get(unwrappedParentUuid)

					if (fromCache) {
						return new AnyDirWithContext.Normal(fromCache)
					}
				}
			}

			return null
		}

		case "sharedRootDirectory": {
			if (drivePath.type === "sharedIn") {
				return "sharedInRoot"
			}

			// We can use the users normal drive cache here since it's a shared out item that they are sharing, it belongs to their normal drive structure
			const fromCache = cache.directoryUuidToAnyNormalDir.get(item.data.uuid)

			if (fromCache) {
				if (fromCache.tag === AnyNormalDir_Tags.Dir) {
					const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)

					if (unwrappedParentUuid) {
						if (cache.rootUuid && unwrappedParentUuid === cache.rootUuid) {
							return new AnyDirWithContext.Normal(
								new AnyNormalDir.Root({
									uuid: cache.rootUuid
								})
							)
						}

						const parentFromCache = cache.directoryUuidToAnyNormalDir.get(unwrappedParentUuid)

						if (parentFromCache) {
							return new AnyDirWithContext.Normal(parentFromCache)
						}
					}
				}
			}

			return null
		}

		case "sharedRootFile": {
			if (drivePath.type === "sharedIn") {
				return "sharedInRoot"
			}

			// We can use the users normal drive cache here since it's a shared out item that they are sharing, it belongs to their normal drive structure
			const fromCache = cache.fileUuidToNormalFile.get(item.data.uuid)

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)

				if (unwrappedParentUuid) {
					if (cache.rootUuid && unwrappedParentUuid === cache.rootUuid) {
						return new AnyDirWithContext.Normal(
							new AnyNormalDir.Root({
								uuid: cache.rootUuid
							})
						)
					}

					const parentFromCache = cache.directoryUuidToAnyNormalDir.get(unwrappedParentUuid)

					if (parentFromCache) {
						return new AnyDirWithContext.Normal(parentFromCache)
					}
				}
			}

			return null
		}
	}
}

export function makeDriveItemPublicLink({
	item,
	linkUuid,
	linkKey
}: {
	item: DriveItem
	linkUuid: string
	linkKey?: string
}): string | null {
	switch (item.type) {
		case "file": {
			if (item.data.meta.tag !== FileMeta_Tags.Decoded) {
				return null
			}

			return `${FILE_PUBLIC_LINK_URL_PREFIX}${linkUuid}${encodeURIComponent("#")}${Buffer.from(item.data.meta.inner[0].key, "utf-8").toString("hex")}`
		}

		case "directory": {
			if (!linkKey) {
				return null
			}

			return `${DIRECTORY_PUBLIC_LINK_URL_PREFIX}${linkUuid}${encodeURIComponent("#")}${Buffer.from(linkKey, "utf-8").toString("hex")}`
		}

		default: {
			return null
		}
	}
}

export function linkedFileIntoDriveItem(file: LinkedFile): DriveItem {
	return unwrappedFileIntoDriveItem(
		unwrapFileMeta({
			uuid: file.uuid,
			// A public link reports no whole-life id, and the SDK models that absence rather than
			// inventing one: such a file is readable (download, thumbnail, media URL) but is rejected
			// by any drive operation with ErrorKind.MissingStableUuid. That is the correct shape here.
			stableUuid: undefined,
			timestamp: file.timestamp,
			size: file.size,
			region: file.region,
			bucket: file.bucket,
			chunks: file.chunks,
			meta: new FileMeta.Decoded({
				name: file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? file.name.inner[0] : file.uuid,
				mime: file.mime.tag === MaybeEncryptedUniffi_Tags.Decrypted ? file.mime.inner[0] : "application/octet-stream",
				size: file.size,
				version: file.version,
				key: file.fileKey,
				created: file.timestamp,
				modified: file.timestamp,
				hash: undefined
			}),
			parent: new ParentUuid.Uuid(file.uuid),
			// The SDK's own gate (decrypted name + mime, 0.4.42+) — thumbnails.canGenerate trusts it.
			canMakeThumbnail: file.canMakeThumbnail,
			favorited: false
		} satisfies File)
	)
}
