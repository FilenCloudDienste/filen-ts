import { describe, it, expect } from "vitest"
import { visibleChats } from "@/features/chats/chatSelectors"
import { deriveBlockedUsers } from "@filen/shared"
import { type Chat } from "@/types"

const blocked = deriveBlockedUsers([{ uuid: "x", userId: 99n, email: "b@x.com", avatar: undefined, nickName: "B", timestamp: 0n }] as never)

describe("visibleChats", () => {
	function chat(uuid: string, ownerId: bigint, participantIds: bigint[], hasMessage: boolean): Chat {
		return {
			uuid,
			ownerId,
			lastMessage: hasMessage ? {} : undefined,
			participants: participantIds.map(userId => ({ userId, email: "" }))
		} as unknown as Chat
	}

	it("keeps owned or messaged chats and drops 1:1s with a blocked user", () => {
		const chats = [
			chat("owned-empty", 1n, [1n, 7n], false),
			chat("foreign-empty", 7n, [1n, 7n], false),
			chat("foreign-messaged", 7n, [1n, 7n], true),
			chat("blocked-1on1", 1n, [1n, 99n], true),
			chat("group-with-blocked", 7n, [1n, 7n, 99n], true)
		]

		expect(visibleChats(chats, 1n, blocked).map(c => c.uuid)).toEqual(["owned-empty", "foreign-messaged", "group-with-blocked"])
	})
})
