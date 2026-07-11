import { describe, expect, it } from "vitest"
import { MailOpenIcon, Volume2Icon, VolumeOffIcon, UsersIcon, PencilIcon, Trash2Icon, LogOutIcon } from "lucide-react"
import type { Chat, ChatParticipant, UuidStr } from "@filen/sdk-rs"
import { chatMenuActions, type ChatActionDescriptor } from "@/features/chats/components/chatMenu.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockParticipant(overrides: Partial<ChatParticipant> = {}): ChatParticipant {
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

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

// exactOptionalPropertyTypes distinguishes "key absent" from "key present with value undefined" —
// builds an undecryptable-style Chat by never including `key` at all (mirrors chatsSort.test.ts's own
// mockUndecryptableChat).
function mockUndecryptableChat(overrides: Omit<Partial<Chat>, "key"> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

function ids(chat: Chat, userId: bigint | undefined, hasUnread = false): string[] {
	return chatMenuActions(chat, userId, hasUnread).map(d => d.id)
}

function facts(chat: Chat, userId: bigint | undefined, hasUnread = false): { id: string; labelKey: string; icon: unknown }[] {
	return chatMenuActions(chat, userId, hasUnread).map(d => ({ id: d.id, labelKey: d.labelKey, icon: d.icon }))
}

describe("chatMenuActions — owner, normal (decryptable) chat, no unread", () => {
	it("mute/participants/rename/delete, in that order (no markRead)", () => {
		expect(ids(mockChat({ ownerId: 1n }), 1n)).toEqual(["mute", "participants", "rename", "delete"])
	})
})

describe("chatMenuActions — non-owner (participant), normal chat", () => {
	it("omits rename; ends in leave instead of delete", () => {
		expect(ids(mockChat({ ownerId: 1n }), 2n)).toEqual(["mute", "participants", "leave"])
	})

	it("an unresolved current user (undefined) is treated as non-owner", () => {
		expect(ids(mockChat({ ownerId: 1n }), undefined)).not.toContain("rename")
		expect(ids(mockChat({ ownerId: 1n }), undefined)).toContain("leave")
	})
})

describe("chatMenuActions — unread", () => {
	it("prepends markRead when hasUnread is true", () => {
		expect(ids(mockChat({ ownerId: 1n }), 1n, true)).toEqual(["markRead", "mute", "participants", "rename", "delete"])
	})

	it("omits markRead when hasUnread is false", () => {
		expect(ids(mockChat({ ownerId: 1n }), 1n, false)).not.toContain("markRead")
	})
})

describe("chatMenuActions — undecryptable chat", () => {
	it("reduces to exactly delete for the owner, regardless of unread", () => {
		expect(ids(mockUndecryptableChat({ ownerId: 1n }), 1n, true)).toEqual(["delete"])
	})

	it("reduces to exactly leave for a non-owner", () => {
		expect(ids(mockUndecryptableChat({ ownerId: 1n }), 2n)).toEqual(["leave"])
	})
})

describe("chatMenuActions — mute label toggle", () => {
	it("labels Mute when not yet muted", () => {
		const chat = mockChat({ muted: false, ownerId: 1n })
		expect(chatMenuActions(chat, 1n, false).find(d => d.id === "mute")?.labelKey).toBe("chatActionMute")
	})

	it("labels Unmute when already muted", () => {
		const chat = mockChat({ muted: true, ownerId: 1n })
		expect(chatMenuActions(chat, 1n, false).find(d => d.id === "mute")?.labelKey).toBe("chatActionUnmute")
	})
})

describe("chatMenuActions — run kinds", () => {
	it("rename/delete/leave/participants dispatch their own dialog kind", () => {
		const owner = mockChat({ ownerId: 1n })
		const shared = mockChat({ ownerId: 1n })

		expect(chatMenuActions(owner, 1n, false).find(d => d.id === "rename")).toMatchObject({ run: "dialog", dialogKind: "rename" })
		expect(chatMenuActions(owner, 1n, false).find(d => d.id === "delete")).toMatchObject({
			run: "dialog",
			dialogKind: "delete",
			destructive: true
		})
		expect(chatMenuActions(shared, 2n, false).find(d => d.id === "leave")).toMatchObject({
			run: "dialog",
			dialogKind: "leave",
			destructive: true
		})
		expect(chatMenuActions(owner, 1n, false).find(d => d.id === "participants")).toMatchObject({
			run: "dialog",
			dialogKind: "participants"
		})
	})

	it("markRead/mute run directly (no dialog)", () => {
		const chat = mockChat({ ownerId: 1n })
		const directIds: ChatActionDescriptor["id"][] = ["markRead", "mute"]

		for (const id of directIds) {
			expect(chatMenuActions(chat, 1n, true).find(d => d.id === id)).toMatchObject({ run: "direct" })
		}
	})
})

describe("chatMenuActions — descriptor label/icon facts (CHAT_ACTION_DEFS drift guard)", () => {
	it("owner, unread, normal chat: each descriptor carries its expected label and icon", () => {
		expect(facts(mockChat({ ownerId: 1n }), 1n, true)).toEqual([
			{ id: "markRead", labelKey: "chatActionMarkRead", icon: MailOpenIcon },
			{ id: "mute", labelKey: "chatActionMute", icon: VolumeOffIcon },
			{ id: "participants", labelKey: "chatActionParticipants", icon: UsersIcon },
			{ id: "rename", labelKey: "chatActionRename", icon: PencilIcon },
			{ id: "delete", labelKey: "chatActionDelete", icon: Trash2Icon }
		])
	})

	it("muted: the mute entry carries the Unmute label and icon", () => {
		const chat = mockChat({ muted: true, ownerId: 1n })
		expect(facts(chat, 1n)).toContainEqual({ id: "mute", labelKey: "chatActionUnmute", icon: Volume2Icon })
	})

	it("non-owner: the leave entry carries its expected label and icon", () => {
		expect(facts(mockChat({ ownerId: 1n }), 2n)).toContainEqual({ id: "leave", labelKey: "chatActionLeave", icon: LogOutIcon })
	})
})

describe("chatMenuActions — returns a fresh array each call", () => {
	it("callers may safely treat the result as their own", () => {
		const chat = mockChat({ ownerId: 1n })
		const first = chatMenuActions(chat, 1n, false)
		const second = chatMenuActions(chat, 1n, false)

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})
