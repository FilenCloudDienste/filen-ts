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

describe("EMPTY_CHAT_FLAGS", () => {
	it("has count 0", () => {
		expect(EMPTY_CHAT_FLAGS.count).toBe(0)
	})

	it("has includesUndecryptable false", () => {
		expect(EMPTY_CHAT_FLAGS.includesUndecryptable).toBe(false)
	})

	it("has everyOwnedBySelf false", () => {
		expect(EMPTY_CHAT_FLAGS.everyOwnedBySelf).toBe(false)
	})

	it("has includesMuted false", () => {
		expect(EMPTY_CHAT_FLAGS.includesMuted).toBe(false)
	})

	it("has selfIsParticipantNotOwnerOfEvery false", () => {
		expect(EMPTY_CHAT_FLAGS.selfIsParticipantNotOwnerOfEvery).toBe(false)
	})

	it("has includesUnread false", () => {
		expect(EMPTY_CHAT_FLAGS.includesUnread).toBe(false)
	})

	it("mutation is silently ignored (frozen)", () => {
		const before = EMPTY_CHAT_FLAGS.count
		// In strict mode a mutation of a frozen object would throw,
		// but in a vitest node env assignment to a frozen property is silently dropped.
		// Either way the value must not change.
		try {
			EMPTY_CHAT_FLAGS.count = 999
		} catch {
			// thrown in strict mode — acceptable
		}

		expect(EMPTY_CHAT_FLAGS.count).toBe(before)
	})
})

describe("aggregateChatSelectionFlags", () => {
	it("returns EMPTY_CHAT_FLAGS on empty selection", () => {
		expect(aggregateChatSelectionFlags([], ME)).toBe(EMPTY_CHAT_FLAGS)
	})

	it("returns EMPTY_CHAT_FLAGS when userId is undefined", () => {
		expect(aggregateChatSelectionFlags([chat()], undefined)).toBe(EMPTY_CHAT_FLAGS)
	})

	it("counts chats — single element", () => {
		expect(aggregateChatSelectionFlags([chat()], ME).count).toBe(1)
	})

	it("counts chats — multiple elements", () => {
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

	it("selfIsParticipantNotOwnerOfEvery: false when user is both owner and participant", () => {
		// Edge case: ownerId === userId AND userId also appears in participants.
		// The isOwner clause fires before the !isParticipant check, so the flag
		// correctly resets to false (owner cannot "leave", they must delete).
		const ownerWhoIsAlsoParticipant = chat({
			ownerId: ME,
			participants: [participant(ME), participant(SOMEONE_ELSE)]
		})

		expect(aggregateChatSelectionFlags([ownerWhoIsAlsoParticipant], ME).selfIsParticipantNotOwnerOfEvery).toBe(false)
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

	it("false when no lastFocus (undefined / never opened)", () => {
		const c = chat({ lastMessage: chatMessage(SOMEONE_ELSE, 200n) })

		expect(chatHasUnread(c, ME)).toBe(false)
	})

	it("true when lastFocus = 0n and a newer message from someone else exists", () => {
		// 0n is a valid lastFocus (epoch / never opened); the guard uses an explicit
		// undefined check so 0n is treated as a real timestamp, not a falsy sentinel.
		const c = chat({
			lastFocus: 0n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 1n)
		})

		expect(chatHasUnread(c, ME)).toBe(true)
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

	it("true when message is undecryptable but still newer (undecryptable flag does not suppress unread)", () => {
		// chatHasUnread does not inspect the undecryptable flag on the message;
		// an undecryptable message still contributes to the unread calculation.
		const c = chat({
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(SOMEONE_ELSE, 200n, true)
		})

		expect(chatHasUnread(c, ME)).toBe(true)
	})

	it("false when message is undecryptable but sent by self (senderId guard fires first)", () => {
		const c = chat({
			lastFocus: 100n as unknown as Chat["lastFocus"],
			lastMessage: chatMessage(ME, 200n, true)
		})

		expect(chatHasUnread(c, ME)).toBe(false)
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
