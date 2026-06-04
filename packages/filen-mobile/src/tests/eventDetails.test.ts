import { vi, describe, it, expect } from "vitest"

// eventDetails.ts imports @/lib/i18n at module level (only for the default `t` of
// eventKindToReadable). That chain pulls expo-localization + every locale JSON, so we
// mock it to a key-echoing translator. Every test passes an explicit `t` anyway.
vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

// @/lib/time → expo-localization. eventDetails.ts uses simpleDate() for the timestamp row,
// so the real time module runs; stub the locale source so it resolves deterministically.
vi.mock("expo-localization", () => ({
	getLocales: () => [{ languageTag: "en-US" }]
}))

// The real @filen/sdk-rs ships WASM/native bindings; we only need the tag string-enums that
// eventDetails.ts indexes into (UserEventKind_Tags) and switches on (+ FileMeta/DirMeta tags).
// Values mirror the generated enums (string literals equal to the member name).
vi.mock("@filen/sdk-rs", () => ({
	UserEventKind_Tags: {
		FileUploaded: "FileUploaded",
		FileVersioned: "FileVersioned",
		FileRestored: "FileRestored",
		VersionedFileRestored: "VersionedFileRestored",
		FileMoved: "FileMoved",
		FileRenamed: "FileRenamed",
		FileMetadataChanged: "FileMetadataChanged",
		FileTrash: "FileTrash",
		FileRm: "FileRm",
		FileShared: "FileShared",
		FileLinkEdited: "FileLinkEdited",
		DeleteFilePermanently: "DeleteFilePermanently",
		FolderTrash: "FolderTrash",
		FolderShared: "FolderShared",
		FolderMoved: "FolderMoved",
		FolderRenamed: "FolderRenamed",
		FolderMetadataChanged: "FolderMetadataChanged",
		SubFolderCreated: "SubFolderCreated",
		BaseFolderCreated: "BaseFolderCreated",
		FolderRestored: "FolderRestored",
		FolderColorChanged: "FolderColorChanged",
		DeleteFolderPermanently: "DeleteFolderPermanently",
		FolderLinkEdited: "FolderLinkEdited",
		Login: "Login",
		FailedLogin: "FailedLogin",
		PasswordChanged: "PasswordChanged",
		TwoFaEnabled: "TwoFaEnabled",
		TwoFaDisabled: "TwoFaDisabled",
		RequestAccountDeletion: "RequestAccountDeletion",
		TrashEmptied: "TrashEmptied",
		DeleteAll: "DeleteAll",
		DeleteVersioned: "DeleteVersioned",
		DeleteUnfinished: "DeleteUnfinished",
		CodeRedeemed: "CodeRedeemed",
		EmailChanged: "EmailChanged",
		EmailChangeAttempt: "EmailChangeAttempt",
		RemovedSharedInItems: "RemovedSharedInItems",
		RemovedSharedOutItems: "RemovedSharedOutItems",
		ItemFavorite: "ItemFavorite"
	},
	FileMeta_Tags: {
		Decoded: "Decoded",
		DecryptedUtf8: "DecryptedUTF8",
		DecryptedRaw: "DecryptedRaw",
		Encrypted: "Encrypted",
		RsaEncrypted: "RSAEncrypted"
	},
	DirMeta_Tags: {
		Decoded: "Decoded",
		DecryptedUtf8: "DecryptedUTF8",
		DecryptedRaw: "DecryptedRaw",
		Encrypted: "Encrypted",
		RsaEncrypted: "RSAEncrypted"
	}
}))

// Imported after the mocks above are registered.
import { eventKindToReadable, buildEventDetails } from "@/features/events/eventDetails"
import type { TFunction } from "i18next"

// Echo translator: returns the key it is given so assertions can match on the raw key string.
// Cast through unknown because eventDetails only uses the (key) => string call shape.
const echo = ((key: string) => key) as unknown as TFunction

// Minimal builders matching the verified generated SDK shapes:
//   UserEvent          = { id, timestamp (DateTime=bigint), uuid, kind: UserEventKind }
//   UserEventKind variant = { tag: UserEventKind_Tags.X, inner: [info] }
//   base info          = { ip, userAgent }
//   file info          = { ip, userAgent, metadata: FileMeta }
//   FileMeta.Decoded   = { tag: "Decoded", inner: [{ name, ... }] }

function decodedFileMeta(name: string) {
	return {
		tag: "Decoded",
		inner: [{ name }]
	}
}

function decodedDirMeta(name: string) {
	return {
		tag: "Decoded",
		inner: [{ name }]
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(tag: string, info: Record<string, unknown>): any {
	return {
		id: 1n,
		timestamp: 0n,
		uuid: "uuid-1",
		kind: {
			tag,
			inner: [info]
		}
	}
}

describe("eventKindToReadable", () => {
	it("maps representative file/folder/account kinds to their translation keys (echoed by stub t)", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const kind = (tag: string): any => ({ tag, inner: [{ ip: "", userAgent: "" }] })

		expect(eventKindToReadable(kind("FileUploaded"), echo)).toBe("file_uploaded")
		expect(eventKindToReadable(kind("FileRenamed"), echo)).toBe("file_renamed")
		expect(eventKindToReadable(kind("FolderTrash"), echo)).toBe("directory_trash")
		expect(eventKindToReadable(kind("SubFolderCreated"), echo)).toBe("sub_directory_created")
		expect(eventKindToReadable(kind("Login"), echo)).toBe("login")
		expect(eventKindToReadable(kind("DeleteAll"), echo)).toBe("all_files_deleted")
		expect(eventKindToReadable(kind("ItemFavorite"), echo)).toBe("item_favorite")
	})

	it("falls back to the module default `t` (mocked to echo) when no translator is passed", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const kind = (tag: string): any => ({ tag, inner: [{ ip: "", userAgent: "" }] })

		expect(eventKindToReadable(kind("PasswordChanged"))).toBe("password_changed")
	})
})

describe("buildEventDetails", () => {
	it("emits the four base rows (type/timestamp/ip/user_agent) for a base-info kind like Login", () => {
		const event = makeEvent("Login", { ip: "1.2.3.4", userAgent: "agent-x" })

		const rows = buildEventDetails(event, echo)

		expect(rows.map(r => r.title)).toEqual(["event_type", "timestamp", "ip", "user_agent"])

		expect(rows.find(r => r.title === "event_type")?.value).toBe("login")
		expect(rows.find(r => r.title === "ip")?.value).toBe("1.2.3.4")
		expect(rows.find(r => r.title === "user_agent")?.value).toBe("agent-x")

		// timestamp row is present and non-empty (simpleDate of 0)
		const timestamp = rows.find(r => r.title === "timestamp")?.value

		expect(typeof timestamp).toBe("string")
		expect((timestamp ?? "").length).toBeGreaterThan(0)
	})

	it("appends a decoded file name row for a single-file kind (FileUploaded)", () => {
		const event = makeEvent("FileUploaded", {
			ip: "1.1.1.1",
			userAgent: "ua",
			metadata: decodedFileMeta("photo.jpg")
		})

		const rows = buildEventDetails(event, echo)

		expect(rows.map(r => r.title)).toEqual(["event_type", "timestamp", "ip", "user_agent", "name"])
		expect(rows.find(r => r.title === "name")?.value).toBe("photo.jpg")
		expect(rows.find(r => r.title === "event_type")?.value).toBe("file_uploaded")
	})

	it("appends name + old_name rows for a rename kind (FileRenamed)", () => {
		const event = makeEvent("FileRenamed", {
			ip: "1.1.1.1",
			userAgent: "ua",
			metadata: decodedFileMeta("new.txt"),
			oldMetadata: decodedFileMeta("old.txt")
		})

		const rows = buildEventDetails(event, echo)

		expect(rows.map(r => r.title)).toEqual([
			"event_type",
			"timestamp",
			"ip",
			"user_agent",
			"name",
			"old_name"
		])
		expect(rows.find(r => r.title === "name")?.value).toBe("new.txt")
		expect(rows.find(r => r.title === "old_name")?.value).toBe("old.txt")
	})

	it("appends a dir name row for a folder kind (FolderTrash)", () => {
		const event = makeEvent("FolderTrash", {
			ip: "1.1.1.1",
			userAgent: "ua",
			name: decodedDirMeta("Documents")
		})

		const rows = buildEventDetails(event, echo)

		expect(rows.map(r => r.title)).toEqual(["event_type", "timestamp", "ip", "user_agent", "name"])
		expect(rows.find(r => r.title === "name")?.value).toBe("Documents")
		expect(rows.find(r => r.title === "event_type")?.value).toBe("directory_trash")
	})

	it("renders the encrypted fallback when file metadata is not decoded", () => {
		const event = makeEvent("FileUploaded", {
			ip: "1.1.1.1",
			userAgent: "ua",
			metadata: { tag: "Encrypted", inner: ["ciphertext"] }
		})

		const rows = buildEventDetails(event, echo)

		expect(rows.find(r => r.title === "name")?.value).toBe("encrypted")
	})

	it("maps favorited boolean to yes/no for ItemFavorite", () => {
		const event = makeEvent("ItemFavorite", {
			ip: "1.1.1.1",
			userAgent: "ua",
			metadata: decodedFileMeta("doc.pdf"),
			value: true
		})

		const rows = buildEventDetails(event, echo)

		expect(rows.find(r => r.title === "name")?.value).toBe("doc.pdf")
		expect(rows.find(r => r.title === "favorited")?.value).toBe("yes")
	})
})
