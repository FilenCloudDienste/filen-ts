import {
	type File,
	type Dir,
	type DecryptedFileMeta,
	FileMeta_Tags,
	DirMeta_Tags,
	type DecryptedDirMeta,
	type SharedDir,
	type SharedFile,
	DirWithMetaEnum_Tags,
	type ChatParticipant,
	type NoteParticipant,
	type Contact,
	ManagedAbortController,
	type ManagedAbortSignal,
	PauseSignal as SdkPauseSignal,
	ParentUuid_Tags,
	type ParentUuid,
	FilenSdkError,
	type AnyDirEnum,
	type AnyDirEnumWithShareInfo,
	AnyDirEnum_Tags,
	AnyDirEnumWithShareInfo_Tags,
	type ContactRequestIn,
	type ContactRequestOut
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

export function createCompositePauseSignal(...signals: PauseSignal[]): PauseSignal {
	const controller = new PauseSignal()

	for (const signal of signals) {
		if (signal.isPaused()) {
			controller.pause()
		}

		controller.addEventListener("pause", () => controller.pause())
		controller.addEventListener("resume", () => controller.resume())
	}

	return controller
}

export function unwrapSdkError(error: unknown): FilenSdkError | null {
	if (FilenSdkError.hasInner(error)) {
		const inner = FilenSdkError.getInner(error)

		return inner
	}

	return null
}

export function unwrapAnyDirUuid(dir: AnyDirEnum | AnyDirEnumWithShareInfo): string | null {
	switch (dir.tag) {
		case AnyDirEnum_Tags.Dir: {
			return dir.inner[0].uuid
		}

		case AnyDirEnum_Tags.Root: {
			return dir.inner[0].uuid
		}

		case AnyDirEnum_Tags.RootWithMeta: {
			return dir.inner[0].uuid
		}

		case AnyDirEnumWithShareInfo_Tags.SharedDir: {
			return dir.inner[0].dir.inner[0].uuid
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

export function unwrapDirMeta(dir: Dir | SharedDir):
	| {
			meta: DecryptedDirMeta | null
			shared: false
			dir: Dir
			uuid: string
	  }
	| {
			meta: DecryptedDirMeta | null
			shared: true
			dir: SharedDir
			uuid: string
	  } {
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

	switch (dir.dir.tag) {
		case DirWithMetaEnum_Tags.Dir: {
			const [inner] = dir.dir.inner

			switch (inner.meta.tag) {
				case DirMeta_Tags.Decoded: {
					const [decoded] = inner.meta.inner

					return {
						meta: decoded,
						shared: true,
						dir,
						uuid: inner.uuid
					}
				}

				default: {
					return {
						meta: null,
						shared: true,
						dir,
						uuid: inner.uuid
					}
				}
			}
		}

		case DirWithMetaEnum_Tags.Root: {
			const [inner] = dir.dir.inner

			switch (inner.meta.tag) {
				case DirMeta_Tags.Decoded: {
					const [decoded] = inner.meta.inner

					return {
						meta: decoded,
						shared: true,
						dir,
						uuid: inner.uuid
					}
				}

				default: {
					return {
						meta: null,
						shared: true,
						dir,
						uuid: inner.uuid
					}
				}
			}
		}
	}
}

export function unwrappedDirIntoDriveItem(unwrappedDir: ReturnType<typeof unwrapDirMeta>): DriveItem {
	return (
		unwrappedDir.shared
			? {
					type: "sharedDirectory",
					data: {
						...unwrappedDir.dir,
						size: 0n,
						decryptedMeta: unwrappedDir.meta,
						uuid: unwrappedDir.uuid
					}
				}
			: {
					type: "directory",
					data: {
						...unwrappedDir.dir,
						size: 0n,
						decryptedMeta: unwrappedDir.meta
					}
				}
	) satisfies DriveItem
}

export function unwrapFileMeta(file: File | SharedFile):
	| {
			meta: DecryptedFileMeta | null
			shared: false
			file: File
	  }
	| {
			meta: DecryptedFileMeta | null
			shared: true
			file: SharedFile
	  } {
	if ("uuid" in file) {
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

	switch (file.file.meta.tag) {
		case FileMeta_Tags.Decoded: {
			const [decoded] = file.file.meta.inner

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
	return (
		unwrappedFile.shared
			? {
					type: "sharedFile",
					data: {
						...unwrappedFile.file,
						size: unwrappedFile.meta?.size ?? 0n,
						decryptedMeta: unwrappedFile.meta,
						uuid: unwrappedFile.file.file.uuid
					}
				}
			: {
					type: "file",
					data: {
						...unwrappedFile.file,
						decryptedMeta: unwrappedFile.meta
					}
				}
	) satisfies DriveItem
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
