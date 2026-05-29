import { describe, it, expect } from "vitest"
import { aggregateChatSelectionFlags, EMPTY_CHAT_FLAGS, chatHasUnread } from "@/lib/chatSelectors"
import type { ChatParticipant } from "@filen/sdk-rs"
import type { Chat, ChatMessage } from "@/types"

const ME = 100n
const SOMEONE_ELSE = 200n

function participant(userId: bigint): ChatParticipant {
	return { userId } as ChatParticipant
}

function chatMessage(senderId: bigint, sentTimestamp: bigint, undecryptable = false): ChatMessage {
	return {
		sentTimestamp,
		inner: { senderId },
		undecryptable
	} as unknown as ChatMessage
}

function chat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: "c",
		ownerId: ME,
		muted: false,
		participants: [],
		undecryptable: false,
		...overrides
	} as Chat
}

describe("aggregateChatSelectionFlags", () => {
	it("returns EMPTY_CHAT_FLAGS on empty selection", () => {
		expect(aggregateChatSelectionFlags([], ME)).toBe(EMPTY_CHAT_FLAGS)
	})

	it("returns EMPTY_CHAT_FLAGS when userId is undefined", () => {
		expect(aggregateChatSelectionFlags([chat()], undefined)).toBe(EMPTY_CHAT_FLAGS)
	})

	it("EMPTY_CHAT_FLAGS is frozen", () => {
		expect(Object.isFrozen(EMPTY_CHAT_FLAGS)).toBe(true)
	})

	it("counts chats", () => {
		expect(aggregateChatSelectionFlags([chat(), chat(), chat()], ME).count).toBe(3)
	})

	it("includesMuted true when any chat is muted", () => {
		expect(aggregateChatSelectionFlags([chat(), chat({ muted: true })], ME).includesMuted).toBe(true)
	})

	it("includesMuted false when none muted", () => {
		expect(aggregateChatSelectionFlags([chat(), chat()], ME).includesMuted).toBe(false)
	})

	it("everyOwnedBySelf true when user owns all", () => {
		expect(aggregateChatSelectionFlags([chat(), chat()], ME).everyOwnedBySelf).toBe(true)
	})

	it("everyOwnedBySelf false if any chat is owned by someone else", () => {
		expect(aggregateChatSelectionFlags([chat(), chat({ ownerId: SOMEONE_ELSE })], ME).everyOwnedBySelf).toBe(false)
	})

	it("selfIsParticipantNotOwnerOfEvery: true when user is participant + not owner of all", () => {
		const participated = chat({
			ownerId: SOMEONE_ELSE,
			participants: [participant(ME)]
		})

		expect(aggregateChatSelectionFlags([participated, participated], ME).selfIsParticipantNotOwnerOfEvery).toBe(true)
	})

	it("selfIsParticipantNotOwnerOfEvery: false if user owns any chat", () => {
		const owned = chat()
		const participated = chat({
			ownerId: SOMEONE_ELSE,
			participants: [participant(ME)]
		})

		expect(aggregateChatSelectionFlags([owned, participated], ME).selfIsParticipantNotOwnerOfEvery).toBe(false)
	})

	it("selfIsParticipantNotOwnerOfEvery: false if user is missing from a participant list", () => {
		const stranger = chat({
			ownerId: SOMEONE_ELSE,
			participants: [participant(SOMEONE_ELSE + 1n)]
		})

		expect(aggregateChatSelectionFlags([stranger], ME).selfIsParticipantNotOwnerOfEvery).toBe(false)
	})

	it("combined: mixed muted + owner state", () => {
		const flags = aggregateChatSelectionFlags(
			[
				chat({ muted: true }),
				chat({ ownerId: SOMEONE_ELSE, participants: [participant(ME)] })
			],
			ME
		)

		expect(flags.count).toBe(2)
		expect(flags.includesMuted).toBe(true)
		expect(flags.everyOwnedBySelf).toBe(false)
		expect(flags.selfIsParticipantNotOwnerOfEvery).toBe(false)
	})
})

describe("chatHasUnread", () => {
	it("false when chat is muted", () => {
		const c = chat({
			muted: true,
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n)
		})

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("false when no lastMessage", () => {
		const c = chat({ lastFocus: 100n as unknown as Chat["lastFocus"] })

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("false when no lastFocus (never opened)", () => {
		const c = chat({ lastMessage: chatMessage(SOMEONE_ELSE, 200n) })

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("false when last message is from self", () => {
		const c = chat({
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(ME, 200n)
		})

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("false when lastMessage is older than lastFocus", () => {
		const c = chat({
			lastFocus: 300n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n)
		})

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("false when lastMessage sentTimestamp equals lastFocus (exact boundary)", () => {
		const c = chat({
			lastFocus: 200n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n)
		})

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("true when other user sent a newer message after lastFocus", () => {
		const c = chat({
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n)
		})

		expect(chatHasUnread(c, ME)).toBe(true)
	})
})

describe("aggregateChatSelectionFlags includesUnread", () => {
	it("false when no chats have unread", () => {
		const all = chat()

		expect(aggregateChatSelectionFlags([all, all], ME).includesUnread).toBe(false)
	})

	it("true when any chat has unread", () => {
		const read = chat()
		const unread = chat({
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n)
		})

		expect(aggregateChatSelectionFlags([read, unread], ME).includesUnread).toBe(true)
	})

	it("false when the only chat with a newer message is muted", () => {
		const muted = chat({
			muted: true,
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n)
		})

		expect(aggregateChatSelectionFlags([muted], ME).includesUnread).toBe(false)
	})
})

describe("aggregateChatSelectionFlags includesUndecryptable", () => {
	it("false when no chats are undecryptable", () => {
		expect(aggregateChatSelectionFlags([chat(), chat()], ME).includesUndecryptable).toBe(false)
	})

	it("true when any chat is undecryptable", () => {
		expect(aggregateChatSelectionFlags([chat(), chat({ undecryptable: true })], ME).includesUndecryptable).toBe(true)
	})

	it("EMPTY_CHAT_FLAGS has includesUndecryptable false", () => {
		expect(EMPTY_CHAT_FLAGS.includesUndecryptable).toBe(false)
	})

	it("true when every chat is undecryptable", () => {
		const u1 = chat({ undecryptable: true })
		const u2 = chat({ uuid: "c2", undecryptable: true })

		expect(aggregateChatSelectionFlags([u1, u2], ME).includesUndecryptable).toBe(true)
	})
})
