import type { Chat, LinkedFile, SharedFile, SharedRootDir, SharingRole } from "@filen/sdk-rs"
import { linkedFileIntoDriveItem, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

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
