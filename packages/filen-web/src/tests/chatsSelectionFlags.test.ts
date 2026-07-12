import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, ChatParticipant, UuidStr } from "@filen/sdk-rs"

// selectionFlags.ts imports isChatOwner from lib/actions.ts, which in turn imports the sdk client and
// query client modules — unresolvable/unwanted under node vitest, mirrors notesSelectionFlags.test.ts's
// own mock boundary.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { aggregateChatSelectionFlags, selectableChatsForSelectAll } from "@/features/chats/lib/selectionFlags"

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
// builds an undecryptable-style Chat by never including `key` at all, mirrors chatsSort.test.ts's own
// mockUndecryptableChat.
function undecryptableChat(overrides: Omit<Partial<Chat>, "key"> = {}): Chat {
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

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 2,
		senderEmail: "other@x.io",
		senderNickName: "Other",
		message: "hi",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 200n,
		...overrides
	}
}

const OWNER = 1n

describe("aggregateChatSelectionFlags — empty/degenerate input", () => {
	it("returns the empty-flags shape for an empty selection", () => {
		expect(aggregateChatSelectionFlags([], OWNER)).toMatchObject({ count: 0, everyOwned: false, noneOwned: false })
	})

	it("returns the empty-flags shape when currentUserId is unresolved", () => {
		expect(aggregateChatSelectionFlags([mockChat()], undefined)).toMatchObject({ count: 0, everyOwned: false })
	})
})

describe("aggregateChatSelectionFlags — includesMuted / includesUndecryptable (any-of)", () => {
	it("includesMuted is true when ANY selected chat is muted", () => {
		const flags = aggregateChatSelectionFlags(
			[mockChat({ uuid: testUuid("a") }), mockChat({ uuid: testUuid("b"), muted: true })],
			OWNER
		)

		expect(flags.includesMuted).toBe(true)
	})

	it("includesMuted is false when nothing in the selection is muted", () => {
		const flags = aggregateChatSelectionFlags([mockChat({ uuid: testUuid("a") }), mockChat({ uuid: testUuid("b") })], OWNER)

		expect(flags.includesMuted).toBe(false)
	})

	it("includesUndecryptable is true when any selected chat's group key never decrypted", () => {
		const flags = aggregateChatSelectionFlags([mockChat({ uuid: testUuid("a") }), undecryptableChat({ uuid: testUuid("b") })], OWNER)

		expect(flags.includesUndecryptable).toBe(true)
	})
})

describe("aggregateChatSelectionFlags — everyOwned / noneOwned", () => {
	it("everyOwned is true only when the current user owns every selected chat", () => {
		const allOwned = aggregateChatSelectionFlags(
			[mockChat({ ownerId: OWNER, uuid: testUuid("a") }), mockChat({ ownerId: OWNER, uuid: testUuid("b") })],
			OWNER
		)
		const mixed = aggregateChatSelectionFlags(
			[mockChat({ ownerId: OWNER, uuid: testUuid("a") }), mockChat({ ownerId: 2n, uuid: testUuid("b") })],
			OWNER
		)

		expect(allOwned.everyOwned).toBe(true)
		expect(mixed.everyOwned).toBe(false)
	})

	it("noneOwned is true only when the current user owns NONE of the selected chats", () => {
		const noneOwned = aggregateChatSelectionFlags(
			[mockChat({ ownerId: 2n, uuid: testUuid("a") }), mockChat({ ownerId: 3n, uuid: testUuid("b") })],
			OWNER
		)
		const mixed = aggregateChatSelectionFlags(
			[mockChat({ ownerId: OWNER, uuid: testUuid("a") }), mockChat({ ownerId: 2n, uuid: testUuid("b") })],
			OWNER
		)

		expect(noneOwned.noneOwned).toBe(true)
		expect(mixed.noneOwned).toBe(false)
	})

	it("everyOwned and noneOwned are mutually exclusive for a non-empty selection", () => {
		const allOwned = aggregateChatSelectionFlags([mockChat({ ownerId: OWNER })], OWNER)
		const noneOwned = aggregateChatSelectionFlags([mockChat({ ownerId: 2n })], OWNER)

		expect(allOwned).toMatchObject({ everyOwned: true, noneOwned: false })
		expect(noneOwned).toMatchObject({ everyOwned: false, noneOwned: true })
	})
})

describe("aggregateChatSelectionFlags — includesUnread", () => {
	it("is true when any selected chat has an unread last message from someone else", () => {
		const unread = mockChat({ uuid: testUuid("a"), lastFocus: 100n, lastMessage: mockMessage({ sentTimestamp: 200n }) })
		const flags = aggregateChatSelectionFlags([unread], OWNER)

		expect(flags.includesUnread).toBe(true)
	})

	it("is false when every selected chat's last message is already read or muted", () => {
		const read = mockChat({ uuid: testUuid("a"), lastFocus: 500n, lastMessage: mockMessage({ sentTimestamp: 200n }) })
		const flags = aggregateChatSelectionFlags([read], OWNER)

		expect(flags.includesUnread).toBe(false)
	})
})

describe("selectableChatsForSelectAll", () => {
	it("excludes undecryptable chats", () => {
		const decryptable = mockChat({ uuid: testUuid("a") })
		const undecryptable = undecryptableChat({ uuid: testUuid("b") })

		expect(selectableChatsForSelectAll([decryptable, undecryptable])).toEqual([decryptable])
	})

	it("returns every chat unchanged when none are undecryptable", () => {
		const chats = [mockChat({ uuid: testUuid("a") }), mockChat({ uuid: testUuid("b") })]

		expect(selectableChatsForSelectAll(chats)).toEqual(chats)
	})
})
