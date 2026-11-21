import type { Chat, ChatMessage, ChatParticipant, Dir, File, LinkedFile, SharedFile, SharedRootDir, SharingRole } from "@filen/sdk-rs"
import { linkedFileIntoDriveItem, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

export function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

export function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

export function mockDirItem(overrides: Partial<Dir> = {}): Extract<DriveItem, { type: "directory" }> {
	const item = narrowItem(mockDir(overrides))

	if (item.type !== "directory") {
		throw new Error("expected a directory arm")
	}

	return item
}

export function mockFileItem(overrides: Partial<File> = {}): Extract<DriveItem, { type: "file" }> {
	const item = narrowItem(mockFile(overrides))

	if (item.type !== "file") {
		throw new Error("expected a file arm")
	}

	return item
}

// The user's own file by name and mime, as a drive listing holds it (a real parent, unlike linkedFileItem's).
export function ownedFileItem(name: string, mime: string, overrides: Partial<File> = {}): Extract<DriveItem, { type: "file" }> {
	const size = overrides.size ?? 1_024n

	return mockFileItem({
		meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size, key: "key", version: 2 } },
		...overrides
	})
}

// The wasm runtime hands a SharingRole over internally tagged, `{ type, email, id }`; the generated
// .d.ts types it externally tagged, a shape no runtime value has. Fixtures build the runtime one, so
// every reader is tested against what it actually receives (shareRoleKind/shareIdentityFromRole).
export function sharerRole(id: number, email: string): SharingRole {
	return { type: "sharer", email, id } as unknown as SharingRole
}

export function receiverRole(id: number, email: string): SharingRole {
	return { type: "receiver", email, id } as unknown as SharingRole
}

export function mockSharedRootDir(overrides: Partial<SharedRootDir> = {}): SharedRootDir {
	return {
		inner: {
			uuid: testUuid("sroot"),
			color: "default",
			timestamp: 1_700_000_000_000n,
			meta: { type: "decoded", data: { name: "SharedRoot" } }
		},
		sharingRole: sharerRole(42, "sharer@filen.io"),
		writeAccess: true,
		...overrides
	}
}

export function mockSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
	return {
		uuid: testUuid("sfile"),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: sharerRole(7, "receiver@filen.io"),
		sharedTag: true,
		canMakeThumbnail: false,
		...overrides
	}
}

// The Shared by me root lists one item once per receiver: same uuid, a different counterpart per row.
export function receiverRow(receiverId: number): DriveItem {
	return narrowItem(
		mockSharedFile({
			uuid: testUuid("shared"),
			meta: {
				type: "decoded",
				data: { name: "Report", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
			},
			sharingRole: receiverRole(receiverId, `${String(receiverId)}@x.com`)
		})
	)
}

// A public link's resolved file: not previewable by default, so a link view shows its hero card.
export function mockLinkedFile(overrides: Partial<LinkedFile> = {}): LinkedFile {
	return {
		uuid: "f1000000-0000-0000-0000-000000000000",
		name: { Decrypted: "archive.bin" },
		mime: { Decrypted: "application/octet-stream" },
		size: 10n,
		chunks: 1n,
		region: "",
		bucket: "",
		version: 2,
		timestamp: 0n,
		fileKey: "k",
		downloadable: true,
		linkedTag: true,
		canMakeThumbnail: false,
		...overrides
	}
}

export function linkedFileItem(name: string, overrides: Partial<LinkedFile> = {}): DriveItem {
	return linkedFileIntoDriveItem(mockLinkedFile({ name: { Decrypted: name }, ...overrides }))
}

export function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

// An undecryptable chat: the group key is absent, never `key: undefined` (exactOptionalPropertyTypes).
export function mockUndecryptableChat(overrides: Omit<Partial<Chat>, "key"> = {}): Chat {
	const chat = mockChat(overrides)

	delete chat.key

	return chat
}

export function mockChatParticipant(overrides: Partial<ChatParticipant> = {}): ChatParticipant {
	return {
		userId: 2n,
		email: "p@x.io",
		nickName: undefined,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n,
		...overrides
	}
}

export function mockChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		chat: testUuid("chat"),
		senderId: 1,
		senderEmail: "sender@filen.io",
		senderNickName: undefined,
		message: "hi",
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		...overrides
	}
}

// An undecryptable message: the `message` key is absent, never `message: undefined`.
export function mockUndecryptableChatMessage(overrides: Omit<Partial<ChatMessage>, "message"> = {}): ChatMessage {
	const message = mockChatMessage(overrides)

	delete message.message

	return message
}
