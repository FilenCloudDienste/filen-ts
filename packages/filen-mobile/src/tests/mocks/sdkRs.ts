/**
 * The uniffi enum surface of @filen/sdk-rs most suites touch, for Vitest (the real bindings need the native
 * module). Variants are classes carrying `tag` and a 1-tuple `inner`, as the generated bindings build them;
 * the *_Tags enums are string-valued like the real ones. Exports a test never reads are inert.
 *
 * Usage: vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkRs")), or spread it and add the
 * suite's own names (ErrorKind, extra enums, spied variants).
 */

import { vi } from "vitest"

function taggedVariant(tag: string) {
	return class {
		tag = tag
		inner: unknown[]

		constructor(inner: unknown) {
			this.inner = [inner]
		}
	}
}

export const AnyDirWithContext = {
	Normal: taggedVariant("Normal"),
	Shared: taggedVariant("Shared"),
	Linked: taggedVariant("Linked")
}

export const AnyNormalDir = {
	Dir: taggedVariant("Dir"),
	Root: taggedVariant("Root")
}

export const AnySharedDir = {
	Dir: taggedVariant("Dir"),
	Root: taggedVariant("Root")
}

export const AnyLinkedDir = {
	Dir: taggedVariant("Dir"),
	Root: taggedVariant("Root")
}

export const AnyFile = {
	File: taggedVariant("File"),
	Shared: taggedVariant("Shared"),
	Linked: taggedVariant("Linked")
}

export const SharingRole = {
	Sharer: taggedVariant("Sharer"),
	Receiver: taggedVariant("Receiver")
}

export const AnySharedDirWithContext = {
	new: (opts: unknown) => opts
}

export const ManagedFuture = {
	new: vi.fn(() => ({}))
}

export enum AnyDirWithContext_Tags {
	Shared = "Shared",
	Linked = "Linked",
	Normal = "Normal"
}

export enum AnyNormalDir_Tags {
	Dir = "Dir",
	Root = "Root"
}

export enum AnySharedDir_Tags {
	Dir = "Dir",
	Root = "Root"
}

export enum AnyLinkedDir_Tags {
	Dir = "Dir",
	Root = "Root"
}

export enum NonRootDir_Tags {
	Normal = "Normal",
	Shared = "Shared",
	Linked = "Linked"
}

export enum NonRootItem_Tags {
	NormalDir = "NormalDir",
	File = "File",
	SharedDir = "SharedDir",
	LinkedDir = "LinkedDir"
}

export enum ParentUuid_Tags {
	Uuid = "Uuid",
	Trash = "Trash",
	Recents = "Recents",
	Favorites = "Favorites",
	Links = "Links"
}

export enum SharingRole_Tags {
	Sharer = "Sharer",
	Receiver = "Receiver"
}

export enum SocketEvent_Tags {
	AuthSuccess = "AuthSuccess",
	AuthFailed = "AuthFailed",
	Reconnecting = "Reconnecting",
	Unsubscribed = "Unsubscribed",
	Drive = "Drive",
	DriveMalformed = "DriveMalformed",
	Chat = "Chat",
	Note = "Note",
	Contact = "Contact",
	General = "General"
}

export enum DriveEvent_Tags {
	FileNew = "FileNew",
	FileRestore = "FileRestore",
	FileMove = "FileMove",
	FileTrash = "FileTrash",
	FileArchived = "FileArchived",
	FileArchiveRestored = "FileArchiveRestored",
	FileDeletedPermanent = "FileDeletedPermanent",
	FileMetadataChanged = "FileMetadataChanged",
	FolderSubCreated = "FolderSubCreated",
	FolderMove = "FolderMove",
	FolderTrash = "FolderTrash",
	FolderRestore = "FolderRestore",
	FolderColorChanged = "FolderColorChanged",
	FolderMetadataChanged = "FolderMetadataChanged",
	FolderDeletedPermanent = "FolderDeletedPermanent",
	ItemFavorite = "ItemFavorite",
	TrashEmpty = "TrashEmpty",
	DeleteAll = "DeleteAll",
	DeleteVersioned = "DeleteVersioned"
}
