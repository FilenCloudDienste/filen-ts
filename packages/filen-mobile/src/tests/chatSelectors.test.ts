import { describe, it, expect } from "vitest"
import { aggregateChatSelectionFlags, EMPTY_CHAT_FLAGS } from "@/lib/chatSelectors"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"

const ME = 100n
const SOMEONE_ELSE = 200n

function participant(userId: bigint): ChatParticipant {
	return { userId } as ChatParticipant
}

function chat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: "c",
		ownerId: ME,
		muted: false,
		participants: [],
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
