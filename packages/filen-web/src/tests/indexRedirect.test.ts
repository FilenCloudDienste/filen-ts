import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"
import { chatsIndexRedirectTarget } from "@/features/chats/lib/indexRedirect.logic"
import { notesIndexRedirectTarget } from "@/features/notes/lib/indexRedirect.logic"
import { mockNote } from "@/tests/fixtures/notes"
import { mockPlainBlockedContact } from "@/tests/support/contactFixtures"
import { testUuid } from "@/tests/support/uuid"

const SELF = 1n

function mockParticipant(userId: bigint): ChatParticipant {
	return {
		userId,
		email: `${String(userId)}@example.com`,
		nickName: undefined,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n
	}
}

function mockMessage(chat: string): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 2,
		senderEmail: "2@example.com",
		senderNickName: undefined,
		message: "hi",
		chat: testUuid(chat),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1_000n
	}
}

function mockChat(label: string, overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid(label),
		ownerId: SELF,
		key: "chat-key",
		participants: [mockParticipant(SELF), mockParticipant(2n)],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

describe("chatsIndexRedirectTarget", () => {
	const chats = [mockChat("a"), mockChat("b")]
	const base = { chats, pending: false, currentUserId: SELF, blocked: EMPTY_BLOCKED_USERS }

	it("redirects to the stored conversation while the list still has it", () => {
		expect(chatsIndexRedirectTarget({ ...base, storedUuid: testUuid("b") })).toBe(testUuid("b"))
	})

	it("keeps the select prompt when the stored conversation is gone", () => {
		expect(chatsIndexRedirectTarget({ ...base, storedUuid: testUuid("gone") })).toBeNull()
	})

	it("keeps the select prompt when nothing is stored, without waiting on the list", () => {
		expect(chatsIndexRedirectTarget({ ...base, storedUuid: null, chats: undefined, pending: true })).toBeNull()
	})

	it("stays undecided while the stored value or the list is loading", () => {
		expect(chatsIndexRedirectTarget({ ...base, storedUuid: undefined })).toBeUndefined()
		expect(chatsIndexRedirectTarget({ ...base, storedUuid: testUuid("a"), chats: undefined, pending: true })).toBeUndefined()
	})

	it("keeps the select prompt when the list failed to load", () => {
		expect(chatsIndexRedirectTarget({ ...base, storedUuid: testUuid("a"), chats: undefined })).toBeNull()
	})

	it("does not reopen a 1:1 the sidebar hides because the other participant is blocked", () => {
		const blocked = deriveBlockedUsers([mockPlainBlockedContact({ userId: 2n })])

		expect(chatsIndexRedirectTarget({ ...base, blocked, storedUuid: testUuid("a") })).toBeNull()
	})

	it("does not reopen a conversation the sidebar does not list", () => {
		// Not owned and never messaged.
		const unlisted = mockChat("u", { ownerId: 2n })
		const listed = mockChat("m", { ownerId: 2n, lastMessage: mockMessage("m") })

		expect(chatsIndexRedirectTarget({ ...base, chats: [unlisted, listed], storedUuid: testUuid("u") })).toBeNull()
		expect(chatsIndexRedirectTarget({ ...base, chats: [unlisted, listed], storedUuid: testUuid("m") })).toBe(testUuid("m"))
	})
})

describe("notesIndexRedirectTarget", () => {
	const older = mockNote({ uuid: testUuid("older"), editedTimestamp: 1n })
	const newer = mockNote({ uuid: testUuid("newer"), editedTimestamp: 2n })
	const notes = [older, newer]

	it("redirects to the stored note while it still exists", () => {
		expect(notesIndexRedirectTarget({ storedUuid: testUuid("older"), notes, pending: false })).toBe(testUuid("older"))
	})

	it("falls back to the first sorted note when the stored note is gone", () => {
		expect(notesIndexRedirectTarget({ storedUuid: testUuid("gone"), notes, pending: false })).toBe(testUuid("newer"))
	})

	it("falls back to the first sorted note when nothing is stored", () => {
		expect(notesIndexRedirectTarget({ storedUuid: null, notes, pending: false })).toBe(testUuid("newer"))
	})

	it("has nothing to open with no notes, even before the stored value resolves", () => {
		expect(notesIndexRedirectTarget({ storedUuid: undefined, notes: [], pending: false })).toBeNull()
		expect(notesIndexRedirectTarget({ storedUuid: testUuid("older"), notes: undefined, pending: false })).toBeNull()
	})

	it("stays undecided while the list or the stored value is loading", () => {
		expect(notesIndexRedirectTarget({ storedUuid: null, notes: undefined, pending: true })).toBeUndefined()
		expect(notesIndexRedirectTarget({ storedUuid: undefined, notes, pending: false })).toBeUndefined()
	})
})
