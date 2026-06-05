import {
	type File,
	type Dir,
	type DecryptedFileMeta,
	FileMeta_Tags,
	DirMeta_Tags,
	type DecryptedDirMeta,
	type SharedDir,
	type SharedFile,
	type ChatParticipant,
	type NoteParticipant,
	type Contact,
	ParentUuid_Tags,
	ParentUuid,
	type ContactRequestIn,
	type ContactRequestOut,
	type SharedRootDir,
	SharingRole,
	AnyDirWithContext,
	AnyDirWithContext_Tags,
	AnyNormalDir_Tags,
	AnySharedDir_Tags,
	AnyNormalDir,
	AnySharedDir,
	AnyFile,
	AnyFile_Tags,
	AnyLinkedDir_Tags,
	type LinkedFile,
	FileMeta,
	MaybeEncryptedUniffi_Tags
} from "@filen/sdk-rs"
import {
	FILE_PUBLIC_LINK_URL_PREFIX,
	DIRECTORY_PUBLIC_LINK_URL_PREFIX
} from "@/constants"
import mimeTypes from "mime-types"
import type { DriveItem, Prettify } from "@/types"
import cache from "@/lib/cache"
import type { DrivePath } from "@/hooks/useDrivePath"

export function unwrapAnyDirUuid(dir: AnyDirWithContext): string | null {
	switch (dir.tag) {
		case AnyDirWithContext_Tags.Linked: {
			switch (dir.inner[0].dir.tag) {
				case AnyLinkedDir_Tags.Dir: {
					return dir.inner[0].dir.inner[0].inner.uuid
				}

				case AnyLinkedDir_Tags.Root: {
					return dir.inner[0].dir.inner[0].inner.uuid
				}

				default: {
					return null
				}
			}
		}

		case AnyDirWithContext_Tags.Normal: {
			switch (dir.inner[0].tag) {
				case AnyNormalDir_Tags.Dir: {
					return dir.inner[0].inner[0].uuid
				}

				case AnyNormalDir_Tags.Root: {
					return dir.inner[0].inner[0].uuid
				}

				default: {
					return null
				}
			}
		}

		case AnyDirWithContext_Tags.Shared: {
			switch (dir.inner[0].dir.tag) {
				case AnySharedDir_Tags.Dir: {
					return dir.inner[0].dir.inner[0].inner.uuid
				}

				case AnySharedDir_Tags.Root: {
					return dir.inner[0].dir.inner[0].inner.uuid
				}

				default: {
					return null
				}
			}
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
				switch (dir.inner[0].dir.tag) {
					case AnySharedDir_Tags.Dir: {
						return unwrapDirMeta(dir.inner[0].dir.inner[0])
					}

					case AnySharedDir_Tags.Root: {
						return unwrapDirMeta(dir.inner[0].dir.inner[0])
					}

					default: {
						throw new Error("Unknown AnySharedDir tag")
					}
				}
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
		switch (dir.tag) {
			case AnySharedDir_Tags.Dir: {
				return unwrapDirMeta(dir.inner[0])
			}

			case AnySharedDir_Tags.Root: {
				return unwrapDirMeta(dir.inner[0])
			}

			default: {
				throw new Error("Unknown AnySharedDir tag")
			}
		}
	}

	if ("uuid" in dir) {
		switch (dir.meta.tag) {
			case DirMeta_Tags.Decoded: {
				const [decoded] = dir.meta.inner

				return {
					meta: decoded,
					shared: false,
					dir,
					uuid: dir.uuid,
					undecryptable: false
				}
			}

			default: {
				return {
					meta: null,
					shared: false,
					dir,
					uuid: dir.uuid,
					undecryptable: true
				}
			}
		}
	}

	if ("sharedTag" in dir) {
		switch (dir.inner.meta.tag) {
			case DirMeta_Tags.Decoded: {
				const [decoded] = dir.inner.meta.inner

				return {
					meta: decoded,
					shared: true,
					root: false,
					dir,
					uuid: dir.inner.uuid,
					sharedTag: dir.sharedTag,
					undecryptable: false
				}
			}

			default: {
				return {
					meta: null,
					shared: true,
					root: false,
					sharedTag: dir.sharedTag,
					dir,
					uuid: dir.inner.uuid,
					undecryptable: true
				}
			}
		}
	}

	switch (dir.inner.meta.tag) {
		case DirMeta_Tags.Decoded: {
			const [decoded] = dir.inner.meta.inner

			return {
				meta: decoded,
				shared: true,
				root: true,
				sharingRole: dir.sharingRole,
				dir,
				uuid: dir.inner.uuid,
				undecryptable: false
			}
		}

		default: {
			return {
				meta: null,
				shared: true,
				root: true,
				sharingRole: dir.sharingRole,
				dir,
				uuid: dir.inner.uuid,
				undecryptable: true
			}
		}
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

	if (!("favorited" in file)) {
		switch (file.meta.tag) {
			case FileMeta_Tags.Decoded: {
				const [decoded] = file.meta.inner

				return {
					meta: decoded,
					shared: true,
					root: true,
					file,
					undecryptable: false
				}
			}

			default: {
				return {
					meta: null,
					shared: true,
					root: true,
					file,
					undecryptable: true
				}
			}
		}
	}

	if ("sharingRole" in file) {
		switch (file.meta.tag) {
			case FileMeta_Tags.Decoded: {
				const [decoded] = file.meta.inner

				return {
					meta: decoded,
					shared: true,
					root: false,
					file: {
						...file,
						sharedTag: true
					},
					undecryptable: false
				}
			}

			default: {
				return {
					meta: null,
					shared: true,
					root: false,
					file: {
						...file,
						sharedTag: true
					},
					undecryptable: true
				}
			}
		}
	}

	switch (file.meta.tag) {
		case FileMeta_Tags.Decoded: {
			const [decoded] = file.meta.inner

			return {
				meta: decoded,
				shared: false,
				root: false,
				file,
				undecryptable: false
			}
		}

		default: {
			return {
				meta: null,
				shared: false,
				root: false,
				file,
				undecryptable: true
			}
		}
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

export function contactDisplayName(contact: Contact | NoteParticipant | ChatParticipant | ContactRequestIn | ContactRequestOut): string {
	return contact.nickName && contact.nickName.length > 0 ? contact.nickName : contact.email
}

/**
 * Make `filename` safe to write as a single path component on iOS (APFS) and
 * Android (ext4/F2FS/FAT32/exFAT): NFC-normalizes, strips control/zero-width
 * characters, replaces the cross-platform-illegal set (`/ : < > " \ | ? *`) and
 * whitespace runs with `replacement` (default `"_"`), removes leading/trailing
 * dots and spaces, drops a leading dot to avoid hidden files, and truncates to
 * 255 UTF-8 bytes while preserving a trailing extension.
 *
 * Degenerate input — empty, all dots/spaces, `"."`, `".."`, or anything that
 * reduces to empty after sanitization — returns the literal `"file"`; it never
 * returns an empty string.
 *
 * Note: this does NOT percent-decode and does NOT strip `%`. A returned name may
 * still contain a bare `%`, so callers must not pass the result to
 * `decodeURIComponent` without their own guard.
 */
export function sanitizeFileName(filename: string, replacement: string = "_"): string {
	// Normalize to UTF-8 NFC form (canonical decomposition followed by canonical composition)
	let sanitizedFilename = filename.normalize("NFC")

	// Remove or replace problematic Unicode characters
	// Remove zero-width characters and other invisible/control characters
	// eslint-disable-next-line no-control-regex
	sanitizedFilename = sanitizedFilename.replace(/[\u200B-\u200D\uFEFF\u00AD\u0000-\u001F\u007F-\u009F]/g, "")

	// iOS specific: Replace characters that cause issues in APFS
	// APFS doesn't allow: / (directory separator) and : (legacy HFS+ path separator)
	// Also problematic: null bytes
	sanitizedFilename = sanitizedFilename.replace(/[/:]/g, replacement)

	// Android specific: Replace characters illegal in FAT32, exFAT, and ext4
	// FAT32/exFAT don't allow: < > : " / \ | ? *
	// Note: Android 12+ uses F2FS/ext4 for internal storage but may use FAT32/exFAT for external
	sanitizedFilename = sanitizedFilename.replace(/[<>:"\\|?*]/g, replacement)

	// Remove leading/trailing dots and spaces (problematic on both platforms)
	// iOS: Leading dots create hidden files
	// Android: Trailing dots/spaces can cause issues
	sanitizedFilename = sanitizedFilename.replace(/^[. ]+|[. ]+$/g, "")

	// Prevent hidden files (leading dot after sanitization)
	if (sanitizedFilename.startsWith(".")) {
		sanitizedFilename = sanitizedFilename.slice(1) || "file"
	}

	// Optionally normalize whitespace (you may want to keep this configurable)
	sanitizedFilename = sanitizedFilename.replace(/\s+/g, replacement)

	// iOS: APFS supports up to 255 UTF-8 bytes per filename component
	// Android: ext4 supports 255 bytes, F2FS supports 255 bytes
	// Both measure in bytes, not characters
	const maxByteLength = 255
	const byteLength = new TextEncoder().encode(sanitizedFilename).length

	// Trim filename preserving extension if possible
	if (byteLength > maxByteLength) {
		const extensionMatch = sanitizedFilename.match(/(\.[^.]{1,10})$/)
		const extension = extensionMatch ? extensionMatch[1] : ""
		const extensionBytes = new TextEncoder().encode(extension).length
		const maxNameBytes = maxByteLength - extensionBytes

		let baseName = extension ? sanitizedFilename.slice(0, -extension.length) : sanitizedFilename
		let baseBytes = new TextEncoder().encode(baseName).length

		while (baseBytes > maxNameBytes && baseName.length > 0) {
			baseName = baseName.slice(0, -1)
			baseBytes = new TextEncoder().encode(baseName).length
		}

		sanitizedFilename = baseName + extension
	}

	// Final validation
	if (!sanitizedFilename || sanitizedFilename === "." || sanitizedFilename === "..") {
		return "file"
	}

	return sanitizedFilename
}

export { listLocalDirectoryRecursive } from "@/lib/fsUtils"

export function normalizeModificationTimestampForComparison(timestamp: number): number {
	return Math.floor(timestamp / 1000)
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

export function resolveMimeType({ mime, name }: { mime: string | null | undefined; name: string }): string {
	return mime || mimeTypes.lookup(name) || "application/octet-stream"
}

export function resolveCreatedOrTimestamp({ created, timestamp }: { created: bigint | undefined; timestamp: bigint }): number {
	return created !== undefined ? Number(created) : Number(timestamp)
}

export function linkedFileIntoDriveItem(file: LinkedFile): DriveItem {
	return unwrappedFileIntoDriveItem(
		unwrapFileMeta({
			uuid: file.uuid,
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
			canMakeThumbnail: false,
			favorited: false
		} satisfies File)
	)
}

export type BigIntToNumber<T> = T extends bigint
	? number
	: T extends Date
		? Date
		: T extends (infer U)[]
			? BigIntToNumber<U>[]
			: T extends object
				? {
						[K in keyof T]: BigIntToNumber<T[K]>
					}
				: T

/**
 * Generic deep converter that walks a value and replaces every `bigint` with its
 * `Number` equivalent, preserving `Date` instances and array/object structure.
 * Used to make SDK responses JSON-serializable.
 */
export function convertBigInts<T>(value: T): BigIntToNumber<T> {
	if (typeof value === "bigint") {
		return Number(value) as BigIntToNumber<T>
	}

	if (value === null || value === undefined) {
		return value as BigIntToNumber<T>
	}

	if (Array.isArray(value)) {
		return value.map(convertBigInts) as BigIntToNumber<T>
	}

	// Preserve Date (and other built-ins you don't want to walk into)
	if (value instanceof Date) {
		return value as BigIntToNumber<T>
	}

	if (typeof value === "object") {
		const out: Record<string, unknown> = {}

		for (const key of Object.keys(value as object)) {
			out[key] = convertBigInts((value as Record<string, unknown>)[key])
		}

		return out as BigIntToNumber<T>
	}

	return value as BigIntToNumber<T>
}
