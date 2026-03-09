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
	ManagedAbortController,
	type ManagedAbortSignal,
	PauseSignal as SdkPauseSignal,
	ParentUuid_Tags,
	ParentUuid,
	FilenSdkError,
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
	AnyLinkedDir_Tags
} from "@filen/sdk-rs"
import * as FileSystem from "expo-file-system"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS, EXPO_AUDIO_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import mimeTypes from "mime-types"
import pathModule from "path"
import type { DriveItem } from "@/types"

export function wrapAbortSignalForSdk(abortSignal: AbortSignal) {
	const abortController = new ManagedAbortController()

	abortSignal.addEventListener(
		"abort",
		() => {
			abortController.abort()
		},
		{
			once: true
		}
	)

	// Need to cast because of a bug in uniffi generated types
	return abortController.signal() as ManagedAbortSignal
}

export function createCompositeAbortSignal(...signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController()

	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort()

			return controller.signal
		}

		signal.addEventListener("abort", () => controller.abort(), {
			once: true
		})
	}

	return controller.signal
}

export class PauseSignal {
	private readonly signal: SdkPauseSignal = new SdkPauseSignal()
	private readonly pauseListeners: Set<() => void> = new Set()
	private readonly resumeListeners: Set<() => void> = new Set()

	public pause(): void {
		if (this.isPaused()) {
			return
		}

		this.signal.pause()

		for (const listener of this.pauseListeners) {
			try {
				listener()
			} catch {
				// Noop
			}
		}
	}

	public resume(): void {
		if (!this.isPaused()) {
			return
		}

		this.signal.resume()

		for (const listener of this.resumeListeners) {
			try {
				listener()
			} catch {
				// Noop
			}
		}
	}

	public isPaused(): boolean {
		return this.signal.isPaused()
	}

	public getSignal(): SdkPauseSignal {
		return this.signal
	}

	public addEventListener<T extends "pause" | "resume">(
		event: T,
		callback: () => void
	): {
		remove: () => void
	} {
		if (event === "resume") {
			this.resumeListeners.add(callback)

			return {
				remove: () => {
					this.resumeListeners.delete(callback)
				}
			}
		}

		this.pauseListeners.add(callback)

		return {
			remove: () => {
				this.pauseListeners.delete(callback)
			}
		}
	}
}

export function createCompositePauseSignal(...signals: PauseSignal[]): PauseSignal & {
	dispose: () => void
} {
	const controller = new PauseSignal()
	const subscriptions: {
		remove: () => void
	}[] = []

	for (const signal of signals) {
		if (signal.isPaused()) {
			controller.pause()
		}

		subscriptions.push(signal.addEventListener("pause", () => controller.pause()))

		subscriptions.push(
			signal.addEventListener("resume", () => {
				if (signals.every(s => !s.isPaused())) {
					controller.resume()
				}
			})
		)
	}

	return Object.assign(controller, {
		dispose: () => {
			for (const sub of subscriptions) {
				sub.remove()
			}

			subscriptions.length = 0
		}
	})
}

export function unwrapSdkError(error: unknown): FilenSdkError | null {
	if (FilenSdkError.hasInner(error)) {
		const inner = FilenSdkError.getInner(error)

		return inner
	}

	return null
}

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
					uuid: dir.uuid
				}
			}

			default: {
				return {
					meta: null,
					shared: false,
					dir,
					uuid: dir.uuid
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
					sharedTag: dir.sharedTag
				}
			}

			default: {
				return {
					meta: null,
					shared: true,
					root: false,
					sharedTag: dir.sharedTag,
					dir,
					uuid: dir.inner.uuid
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
				uuid: dir.inner.uuid
			}
		}

		default: {
			return {
				meta: null,
				shared: true,
				root: true,
				sharingRole: dir.sharingRole,
				dir,
				uuid: dir.inner.uuid
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
					uuid: unwrappedDir.uuid
				}
			}
		}

		return {
			type: "sharedDirectory",
			data: {
				...unwrappedDir.dir,
				size: 0n,
				decryptedMeta: unwrappedDir.meta,
				uuid: unwrappedDir.uuid
			}
		}
	}

	return {
		type: "directory",
		data: {
			...unwrappedDir.dir,
			size: 0n,
			decryptedMeta: unwrappedDir.meta
		}
	}
}

export type UnwrapFileMetaBase = {
	meta: DecryptedFileMeta | null
}

export type UnwrapFileMetaRegular = UnwrapFileMetaBase & {
	shared: false
	file: File
}

export type UnwrapFileMetaShared = UnwrapFileMetaBase & {
	shared: true
	file: SharedFile
}

export type UnwrapFileMetaResult = UnwrapFileMetaRegular | UnwrapFileMetaShared

export function unwrapFileMeta(file: File | SharedFile | AnyFile): UnwrapFileMetaResult {
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

	if ("favorited" in file) {
		switch (file.meta.tag) {
			case FileMeta_Tags.Decoded: {
				const [decoded] = file.meta.inner

				return {
					meta: decoded,
					shared: false,
					file
				}
			}

			default: {
				return {
					meta: null,
					shared: false,
					file
				}
			}
		}
	}

	switch (file.meta.tag) {
		case FileMeta_Tags.Decoded: {
			const [decoded] = file.meta.inner

			return {
				meta: decoded,
				shared: true,
				file
			}
		}

		default: {
			return {
				meta: null,
				shared: true,
				file
			}
		}
	}
}

export function unwrappedFileIntoDriveItem(unwrappedFile: ReturnType<typeof unwrapFileMeta>): DriveItem {
	if (unwrappedFile.shared) {
		return {
			type: "sharedFile",
			data: {
				...unwrappedFile.file,
				size: unwrappedFile.meta?.size ?? 0n,
				decryptedMeta: unwrappedFile.meta,
				uuid: unwrappedFile.file.uuid
			}
		}
	}

	return {
		type: "file",
		data: {
			...unwrappedFile.file,
			decryptedMeta: unwrappedFile.meta
		}
	}
}

export function contactDisplayName(contact: Contact | NoteParticipant | ChatParticipant | ContactRequestIn | ContactRequestOut): string {
	return contact.nickName && contact.nickName.length > 0 ? contact.nickName : contact.email
}

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

export function normalizeFilePathForSdk(filePath: string): string {
	let normalizedPath = filePath
		.trim()
		.replace(/^file:\/+/, "/")
		.split("/")
		.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
		.join("/")

	if (!normalizedPath.startsWith("/")) {
		normalizedPath = "/" + normalizedPath
	}

	if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	return pathModule.posix.normalize(normalizedPath)
}

export function normalizeFilePathForExpo(filePath: string): string {
	let normalizedPath = FileSystem.Paths.normalize(
		normalizeFilePathForSdk(filePath)
			.split("/")
			.map(segment => (segment.length > 0 ? encodeURIComponent(segment) : segment))
			.join("/")
	)

	if (!normalizedPath.startsWith("/")) {
		normalizedPath = "/" + normalizedPath
	}

	if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	return `file://${normalizedPath}`
}

export function normalizeFilePathForBlobUtil(filePath: string): string {
	let normalizedPath = normalizeFilePathForSdk(filePath)
		.split("/")
		.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
		.join("/")

	if (!normalizedPath.startsWith("/")) {
		normalizedPath = "/" + normalizedPath
	}

	if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	return `file://${normalizedPath}`
}

export type PreviewType = "image" | "video" | "unknown" | "pdf" | "text" | "code" | "audio" | "docx"

export function getPreviewType(name: string): PreviewType {
	const extname = FileSystem.Paths.extname(name.trim().toLowerCase())

	if (EXPO_IMAGE_SUPPORTED_EXTENSIONS.has(extname)) {
		return "image"
	}

	if (EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(extname)) {
		return "video"
	}

	if (EXPO_AUDIO_SUPPORTED_EXTENSIONS.has(extname)) {
		return "audio"
	}

	switch (extname) {
		case ".pdf": {
			return "pdf"
		}

		case ".txt": {
			return "text"
		}

		case ".js":
		case ".cjs":
		case ".mjs":
		case ".jsx":
		case ".tsx":
		case ".ts":
		case ".md":
		case ".cpp":
		case ".c":
		case ".php":
		case ".htm":
		case ".html5":
		case ".html":
		case ".css":
		case ".css3":
		case ".coffee":
		case ".litcoffee":
		case ".sass":
		case ".xml":
		case ".json":
		case ".sql":
		case ".java":
		case ".kt":
		case ".swift":
		case ".py3":
		case ".py":
		case ".cmake":
		case ".cs":
		case ".dart":
		case ".dockerfile":
		case ".go":
		case ".less":
		case ".yaml":
		case ".vue":
		case ".svelte":
		case ".vbs":
		case ".cobol":
		case ".toml":
		case ".conf":
		case ".ini":
		case ".log":
		case ".makefile":
		case ".mk":
		case ".gradle":
		case ".lua":
		case ".h":
		case ".hpp":
		case ".rs":
		case ".sh":
		case ".rb":
		case ".ps1":
		case ".bat":
		case ".ps":
		case ".protobuf":
		case ".proto": {
			return "code"
		}

		case ".docx": {
			return "docx"
		}

		default: {
			return "unknown"
		}
	}
}

export function getPreviewTypeFromMime(mimeType: string): PreviewType {
	const normalizedMimeType = mimeType.toLowerCase().trim()
	const extname = mimeTypes.extension(normalizedMimeType)

	if (!extname) {
		return "unknown"
	}

	return getPreviewType(`file.${extname}`)
}

export function listLocalDirectoryRecursive(directory: FileSystem.Directory): (FileSystem.File | FileSystem.Directory)[] {
	const visited = new Set<string>()
	const allEntries: (FileSystem.File | FileSystem.Directory)[] = []

	function traverse(dir: FileSystem.Directory) {
		if (visited.has(dir.uri)) {
			return
		}

		visited.add(dir.uri)

		try {
			const entries = dir.list()

			for (const entry of entries) {
				allEntries.push(entry)

				if (entry instanceof FileSystem.Directory) {
					traverse(entry)
				}
			}
		} catch {
			return
		}
	}

	traverse(directory)

	return allEntries
}

export function normalizeModificationTimestampForComparison(timestamp: number): number {
	return Math.floor(timestamp / 1000)
}
