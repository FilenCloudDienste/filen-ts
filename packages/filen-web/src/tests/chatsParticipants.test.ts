import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"

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
import {
	chatInfoChatActions,
	chatInfoParticipantRows,
	participantRowActions,
	type ChatInfoParticipantRow
} from "@/features/chats/components/chatInfoPanel.logic"
import { deriveBlockedUsers } from "@filen/shared"
import { mockPlainContact } from "@/tests/support/contactFixtures"
import { testUuid } from "@/tests/support/uuid"

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

describe("addChatParticipants — sequential ordering", () => {
	it("is a no-op (no worker call) when every contact is already a participant", async () => {
		const existing = mockParticipant({ userId: 5n })
		const chat = mockChat({ participants: [existing] })
		const contact = mockPlainContact({ userId: 5n })

		const outcome = await addChatParticipants(chat, [contact])

		expect(outcome).toEqual({ status: "success", item: chat })
		expect(addChatParticipantOp).not.toHaveBeenCalled()
	})

	it("threads each add through the PREVIOUS call's returned chat, in list order", async () => {
		const chat = mockChat({ participants: [] })
		const contactA = mockPlainContact({ userId: 10n, email: "a@x.io" })
		const contactB = mockPlainContact({ userId: 20n, email: "b@x.io" })

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
		const already = mockPlainContact({ userId: 5n })
		const fresh = mockPlainContact({ userId: 6n })
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

		const outcome = await addChatParticipants(chat, [mockPlainContact()])

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

describe("chatInfoParticipantRows — ordering, self row and owner/participant view gating", () => {
	const owner = mockParticipant({ userId: 1n })
	const participantA = mockParticipant({ userId: 2n })
	const participantB = mockParticipant({ userId: 3n })
	const chat = mockChat({ ownerId: 1n, participants: [participantA, owner, participantB] })

	it("lists the viewer's own row first, then the owner's, then the rest in chat order", () => {
		expect(chatInfoParticipantRows(chat, 3n).map(r => r.participant.userId)).toEqual([3n, 1n, 2n])
		expect(chatInfoParticipantRows(chat, 1n).map(r => r.participant.userId)).toEqual([1n, 2n, 3n])
	})

	it("marks only the viewer's own row isSelf", () => {
		const rows = chatInfoParticipantRows(chat, 2n)

		expect(rows.filter(r => r.isSelf).map(r => r.participant.userId)).toEqual([2n])
	})

	it("a solo chat lists just the viewer", () => {
		expect(chatInfoParticipantRows(mockChat({ ownerId: 1n, participants: [owner] }), 1n)).toMatchObject([
			{ isSelf: true, isOwner: true }
		])
	})

	it("marks the owner's row via isOwner (chat.ownerId, not a per-participant flag)", () => {
		const rows = chatInfoParticipantRows(chat, 3n)

		expect(rows.find(r => r.participant.userId === 1n)?.isOwner).toBe(true)
		expect(rows.find(r => r.participant.userId === 2n)?.isOwner).toBe(false)
	})

	it("owner viewer: canRemove on every other row, never on their own", () => {
		const rows = chatInfoParticipantRows(chat, 1n)

		expect(rows.map(r => [r.participant.userId, r.canRemove])).toEqual([
			[1n, false],
			[2n, true],
			[3n, true]
		])
	})

	it("participant viewer: canRemove on no row, including the owner's", () => {
		expect(chatInfoParticipantRows(chat, 2n).every(r => !r.canRemove)).toBe(true)
	})

	it("an unresolved viewer (account not loaded) gets no self row and no management", () => {
		const rows = chatInfoParticipantRows(chat, undefined)

		expect(rows.some(r => r.isSelf || r.canRemove)).toBe(false)
	})
})

describe("chatInfoParticipantRows blocked flag", () => {
	const owner = mockParticipant({ userId: 1n, email: "owner@x.io" })
	const participantA = mockParticipant({ userId: 2n, email: "a@x.io" })
	const participantB = mockParticipant({ userId: 3n, email: "b@x.io" })
	const chat = mockChat({ ownerId: 1n, participants: [participantA, owner, participantB] })

	it("marks a participant blocked by userId, leaving the others unblocked", () => {
		const blocked = deriveBlockedUsers([{ userId: 3n, email: "unlisted@x.io" }])
		const rows = chatInfoParticipantRows(chat, 1n, blocked)

		expect(rows.find(r => r.participant.userId === 3n)?.blocked).toBe(true)
		expect(rows.find(r => r.participant.userId === 2n)?.blocked).toBe(false)
	})

	it("marks a participant blocked by email alone, case- and whitespace-insensitively", () => {
		const blocked = deriveBlockedUsers([{ userId: 99n, email: " A@X.IO " }])
		const rows = chatInfoParticipantRows(chat, 1n, blocked)

		expect(rows.find(r => r.participant.userId === 2n)?.blocked).toBe(true)
	})

	it("defaults every row to unblocked when the blocked argument is omitted", () => {
		expect(chatInfoParticipantRows(chat, 1n).every(r => !r.blocked)).toBe(true)
	})

	it("is independent of ownership: a non-owner viewer's rows still carry it, the owner's included", () => {
		const blocked = deriveBlockedUsers([{ userId: 1n, email: "owner@x.io" }])
		const rows = chatInfoParticipantRows(chat, 2n, blocked)

		expect(rows.find(r => r.participant.userId === 1n)).toMatchObject({ isOwner: true, canRemove: false, blocked: true })
	})

	it("never marks the viewer's own row blocked", () => {
		const blocked = deriveBlockedUsers([{ userId: 2n, email: "a@x.io" }])

		expect(chatInfoParticipantRows(chat, 2n, blocked).find(r => r.isSelf)?.blocked).toBe(false)
	})
})

function rowWhere(rows: readonly ChatInfoParticipantRow[], predicate: (row: ChatInfoParticipantRow) => boolean): ChatInfoParticipantRow {
	const row = rows.find(predicate)

	if (row === undefined) {
		throw new Error("no such row")
	}

	return row
}

describe("participantRowActions", () => {
	const owner = mockParticipant({ userId: 1n, email: "owner@x.io" })
	const participantA = mockParticipant({ userId: 2n, email: "a@x.io" })
	const chat = mockChat({ ownerId: 1n, participants: [owner, participantA] })

	it("offers nothing on the viewer's own row", () => {
		expect(participantRowActions(rowWhere(chatInfoParticipantRows(chat, 1n), r => r.isSelf))).toEqual([])
	})

	it("owner viewer: remove, then block", () => {
		expect(participantRowActions(rowWhere(chatInfoParticipantRows(chat, 1n), r => !r.isSelf))).toEqual(["remove", "block"])
	})

	it("participant viewer: block only, unblock once blocked", () => {
		expect(participantRowActions(rowWhere(chatInfoParticipantRows(chat, 2n), r => r.isOwner))).toEqual(["block"])

		const blocked = deriveBlockedUsers([{ userId: 1n, email: "owner@x.io" }])

		expect(participantRowActions(rowWhere(chatInfoParticipantRows(chat, 2n, blocked), r => r.isOwner))).toEqual(["unblock"])
	})
})

describe("chatInfoChatActions", () => {
	const chat = mockChat({ ownerId: 1n, participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n })] })

	it("owner: rename, mute and Delete", () => {
		const actions = chatInfoChatActions(chat, 1n, true)

		expect([actions.rename?.id, actions.mute?.id, actions.end?.id]).toEqual(["rename", "mute", "delete"])
	})

	it("participant: no rename, mute and Leave", () => {
		const actions = chatInfoChatActions(chat, 2n, true)

		expect([actions.rename?.id, actions.mute?.id, actions.end?.id]).toEqual([undefined, "mute", "leave"])
	})

	it("disables every write offline, as the chat menu does", () => {
		const actions = chatInfoChatActions(chat, 1n, false)

		expect([actions.rename?.enabled, actions.mute?.enabled, actions.end?.enabled]).toEqual([false, false, false])
	})
})
