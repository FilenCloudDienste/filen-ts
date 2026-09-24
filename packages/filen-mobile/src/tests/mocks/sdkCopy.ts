/**
 * The slice of @filen/sdk-rs the copy engine touches, for Vitest (the real bindings need the native
 * module). Enum member ORDER matters — numeric enums are compared by value — and copyAdapter.test.ts
 * checks every enum here against the installed generated bindings, so a regenerated SDK that reorders
 * or renames a member fails loudly instead of silently mapping to the wrong phase or stage.
 *
 * Usage: vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkCopy"))
 */

import { vi } from "vitest"

export enum CopyPhase {
	Scanning,
	CreatingDirectories,
	CopyingFiles,
	Finishing,
	Done,
	Cancelled,
	Failed
}

export enum CopyStage {
	CreateDirectory,
	Download,
	Upload,
	Finalize,
	RegisteredAsVersion
}

export enum CopyEvent_Tags {
	DirCreated = "DirCreated",
	DirFailed = "DirFailed",
	FileStarted = "FileStarted",
	FileDone = "FileDone",
	FileFailed = "FileFailed",
	Skipped = "Skipped",
	Renamed = "Renamed",
	PropagationFailed = "PropagationFailed",
	ColorFailed = "ColorFailed"
}

export enum ErrorKind {
	Server,
	Unauthenticated,
	Reqwest,
	Response,
	RetryFailed,
	Conversion,
	Io,
	ChunkTooLarge,
	InvalidState,
	InvalidType,
	InvalidName,
	ImageError,
	MetadataWasNotDecrypted,
	Cancelled,
	HeifError,
	BadRecoveryKey,
	Internal,
	InsufficientMemory,
	Walk,
	FileChangedDuringSync,
	FolderNotFound,
	WrongPassword,
	MaxStorageReached,
	FileChunkNotFound,
	FileNotFound,
	EmailOrPasswordWrong,
	Enter2fa,
	Wrong2fa,
	StaleState,
	MissingStableUuid
}

export enum NonRootNormalItem_Tags {
	Dir = "Dir",
	File = "File"
}

export enum CopyItem_Tags {
	File = "File",
	Dir = "Dir"
}

function taggedUnion(tag: string) {
	return class {
		public readonly tag = tag
		public readonly inner: unknown[]

		public constructor(value: unknown) {
			this.inner = [value]
		}
	}
}

export const CopyItem = {
	File: taggedUnion(CopyItem_Tags.File),
	Dir: taggedUnion(CopyItem_Tags.Dir)
}

export const AnyFile = {
	File: taggedUnion("File"),
	Shared: taggedUnion("Shared"),
	Linked: taggedUnion("Linked")
}

export const AnyDirWithContext = {
	Normal: taggedUnion("Normal"),
	Shared: taggedUnion("Shared"),
	Linked: taggedUnion("Linked")
}

export const AnyNormalDir = {
	Dir: taggedUnion("Dir"),
	Root: taggedUnion("Root")
}

export const AnySharedDir = {
	Dir: taggedUnion("Dir"),
	Root: taggedUnion("Root")
}

export const AnySharedDirWithContext = {
	new: (value: unknown) => value
}

export const ManagedFuture = {
	new: vi.fn((value: unknown) => value)
}

export class FilenSdkError {
	public static hasInner(): boolean {
		return false
	}
}
