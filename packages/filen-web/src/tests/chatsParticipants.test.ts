import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatParticipant, Contact, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { addChatParticipantOp, removeChatParticipantOp } = vi.hoisted(() => ({
	addChatParticipantOp: vi.fn(),
	removeChatParticipantOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		addChatParticipant: addChatParticipantOp,
		removeChatParticipant: removeChatParticipantOp
	}
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { CHATS_QUERY_KEY, chatsQueryGet } from "@/features/chats/queries/chats"
import { addChatParticipants, removeChatParticipant } from "@/features/chats/lib/participants"
import { chatParticipantRows, contactsAvailableToAddToChat } from "@/features/chats/components/chatParticipantsDialog.logic"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockParticipant(overrides: Partial<ChatParticipant> = {}): ChatParticipant {
	return {
		userId: 2n,
		email: "p@x.io",
		nickName: "p",
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
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: testUuid("contact"),
		userId: 2n,
		email: "c@x.io",
		nickName: "c",
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "",
		...overrides
	}
}

describe("addChatParticipants — sequential ordering", () => {
	it("is a no-op (no worker call) when every contact is already a participant", async () => {
		const existing = mockParticipant({ userId: 5n })
		const chat = mockChat({ participants: [existing] })
		const contact = mockContact({ userId: 5n })

		const outcome = await addChatParticipants(chat, [contact])

		expect(outcome).toEqual({ status: "success", item: chat })
		expect(addChatParticipantOp).not.toHaveBeenCalled()
	})

	it("threads each add through the PREVIOUS call's returned chat, in list order", async () => {
		const chat = mockChat({ participants: [] })
		const contactA = mockContact({ userId: 10n, email: "a@x.io" })
		const contactB = mockContact({ userId: 20n, email: "b@x.io" })

		const afterA = mockChat({ participants: [mockParticipant({ userId: 10n, email: "a@x.io" })] })
		const afterB = mockChat({
			participants: [mockParticipant({ userId: 10n, email: "a@x.io" }), mockParticipant({ userId: 20n, email: "b@x.io" })]
		})

		addChatParticipantOp.mockResolvedValueOnce(afterA)
		addChatParticipantOp.mockResolvedValueOnce(afterB)

		const outcome = await addChatParticipants(chat, [contactA, contactB])

		// Call 1: the ORIGINAL chat. Call 2: call 1's OWN result, not the original — proves the loop
		// threads state forward instead of each add starting from the same stale base (mobile's own
		// addParticipants rationale, chats.ts:408-436: a parallel Promise.all had the last write clobber
		// the rest).
		expect(addChatParticipantOp).toHaveBeenNthCalledWith(1, chat, contactA)
		expect(addChatParticipantOp).toHaveBeenNthCalledWith(2, afterA, contactB)
		expect(outcome).toEqual({ status: "success", item: afterB })
		expect(chatsQueryGet()).toEqual([afterB])
	})

	it("skips only the already-present contacts, still adding the rest", async () => {
		const existing = mockParticipant({ userId: 5n })
		const chat = mockChat({ participants: [existing] })
		const already = mockContact({ userId: 5n })
		const fresh = mockContact({ userId: 6n })
		const afterFresh = mockChat({ participants: [existing, mockParticipant({ userId: 6n })] })

		addChatParticipantOp.mockResolvedValueOnce(afterFresh)

		const outcome = await addChatParticipants(chat, [already, fresh])

		expect(addChatParticipantOp).toHaveBeenCalledExactlyOnceWith(chat, fresh)
		expect(outcome).toEqual({ status: "success", item: afterFresh })
	})

	it("returns an error outcome on rejection, without patching the cache", async () => {
		const chat = mockChat({ participants: [] })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		addChatParticipantOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await addChatParticipants(chat, [mockContact()])

		expect(outcome.status).toBe("error")
		expect(chatsQueryGet()).toEqual([chat])
	})
})

describe("removeChatParticipant", () => {
	it("is a no-op (no worker call) when the participant isn't on the chat", async () => {
		const chat = mockChat({ participants: [] })

		const outcome = await removeChatParticipant(chat, mockParticipant())

		expect(outcome).toEqual({ status: "success", item: chat })
		expect(removeChatParticipantOp).not.toHaveBeenCalled()
	})

	it("removes and upserts the resulting chat", async () => {
		const participant = mockParticipant({ userId: 5n })
		const chat = mockChat({ participants: [participant] })
		const updated = mockChat({ participants: [] })
		removeChatParticipantOp.mockResolvedValueOnce(updated)

		const outcome = await removeChatParticipant(chat, participant)

		expect(removeChatParticipantOp).toHaveBeenCalledExactlyOnceWith(chat, 5n)
		expect(outcome).toEqual({ status: "success", item: updated })
		expect(chatsQueryGet()).toEqual([updated])
	})
})

describe("chatParticipantRows — self-exclusion, ordering, and owner/participant view gating", () => {
	const owner = mockParticipant({ userId: 1n })
	const participantA = mockParticipant({ userId: 2n })
	const participantB = mockParticipant({ userId: 3n })
	const chat = mockChat({ ownerId: 1n, participants: [participantA, owner, participantB] })

	it("excludes the viewer's own row entirely (self-management stays the menu's own Leave dialog)", () => {
		expect(chatParticipantRows(chat, 2n, false).map(r => r.participant.userId)).toEqual([1n, 3n])
	})

	it("a chat with no OTHER participants (the solo-owner case) returns an empty list, not a self-row", () => {
		expect(chatParticipantRows(mockChat({ ownerId: 1n, participants: [owner] }), 1n, true)).toEqual([])
	})

	it("sorts the owner's row first among what remains", () => {
		expect(chatParticipantRows(chat, 3n, false).map(r => r.participant.userId)).toEqual([1n, 2n])
	})

	it("marks the owner's row via isOwner (chat.ownerId, not a per-participant flag)", () => {
		const rows = chatParticipantRows(chat, 3n, false)

		expect(rows.find(r => r.participant.userId === 1n)?.isOwner).toBe(true)
		expect(rows.find(r => r.participant.userId === 2n)?.isOwner).toBe(false)
	})

	it("owner viewer: canManage is true on every remaining (non-owner) row", () => {
		const rows = chatParticipantRows(chat, 1n, true)

		expect(rows.map(r => r.participant.userId)).toEqual([2n, 3n])
		expect(rows.every(r => r.canManage)).toBe(true)
	})

	it("participant viewer: canManage is false on every row, including the owner's", () => {
		const rows = chatParticipantRows(chat, 2n, false)

		expect(rows.every(r => !r.canManage)).toBe(true)
	})

	it("the owner's row never gets canManage even when it survives another owner-viewer's self-filter", () => {
		const rows = chatParticipantRows(chat, 3n, false)

		expect(rows.find(r => r.participant.userId === 1n)?.canManage).toBe(false)
	})
})

describe("contactsAvailableToAddToChat", () => {
	it("filters out contacts already a participant, preserving source order", () => {
		const chat = mockChat({ participants: [mockParticipant({ userId: 5n })] })
		const already = mockContact({ userId: 5n })
		const fresh1 = mockContact({ uuid: testUuid("c1"), userId: 6n })
		const fresh2 = mockContact({ uuid: testUuid("c2"), userId: 7n })

		expect(contactsAvailableToAddToChat([already, fresh1, fresh2], chat)).toEqual([fresh1, fresh2])
	})

	it("returns every contact when none are participants yet", () => {
		const chat = mockChat({ participants: [] })
		const contacts = [mockContact({ userId: 1n }), mockContact({ userId: 2n })]

		expect(contactsAvailableToAddToChat(contacts, chat)).toEqual(contacts)
	})
})
