import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { chatMessageNotification, NOTIFICATION_BODY_MAX_LENGTH } from "@/features/desktop/lib/notifications"
import { testUuid } from "@/tests/support/uuid"

const ME = 1n
const LABELS = { undecryptableChat: "Encrypted conversation", soloFallback: "Just you", undecryptableMessage: "Unreadable" }

function participant(userId: bigint, email: string, nickName: string): ChatParticipant {
	return { userId, email, nickName } as ChatParticipant
}

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: ME,
		key: "chat-key",
		participants: [participant(ME, "me@x.io", "Me"), participant(2n, "peer@x.io", "Peer")],
		muted: false,
		created: 0n,
		lastFocus: 100n,
		...overrides
	}
}

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 2,
		senderEmail: "peer@x.io",
		senderNickName: "Peer",
		message: "hi",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 200n,
		...overrides
	}
}

describe("chatMessageNotification", () => {
	it("titles a one-to-one message by the other person", () => {
		expect(chatMessageNotification(mockMessage(), mockChat(), ME, EMPTY_BLOCKED_USERS, LABELS)).toEqual({ title: "Peer", body: "hi" })
	})

	it("names the group and prefixes the sender", () => {
		const chat = mockChat({
			name: "Team",
			participants: [participant(ME, "me@x.io", "Me"), participant(2n, "peer@x.io", "Peer"), participant(3n, "third@x.io", "")]
		})

		expect(chatMessageNotification(mockMessage(), chat, ME, EMPTY_BLOCKED_USERS, LABELS)).toEqual({ title: "Team", body: "Peer: hi" })
	})

	it("stays silent for own, blocked, muted or already-read messages", () => {
		expect(chatMessageNotification(mockMessage({ senderId: 1 }), mockChat(), ME, EMPTY_BLOCKED_USERS, LABELS)).toBeNull()
		expect(
			chatMessageNotification(mockMessage(), mockChat(), ME, deriveBlockedUsers([{ userId: 2n, email: "peer@x.io" }]), LABELS)
		).toBeNull()
		expect(chatMessageNotification(mockMessage(), mockChat({ muted: true }), ME, EMPTY_BLOCKED_USERS, LABELS)).toBeNull()
		expect(chatMessageNotification(mockMessage({ sentTimestamp: 50n }), mockChat(), ME, EMPTY_BLOCKED_USERS, LABELS)).toBeNull()
	})

	it("stays silent before the account is known", () => {
		expect(chatMessageNotification(mockMessage(), mockChat(), undefined, EMPTY_BLOCKED_USERS, LABELS)).toBeNull()
	})

	it("falls back to the sender for a chat not cached yet, still skipping own and blocked senders", () => {
		expect(chatMessageNotification(mockMessage({ senderNickName: "" }), undefined, ME, EMPTY_BLOCKED_USERS, LABELS)).toEqual({
			title: "peer@x.io",
			body: "hi"
		})
		expect(chatMessageNotification(mockMessage({ senderId: 1 }), undefined, ME, EMPTY_BLOCKED_USERS, LABELS)).toBeNull()
		expect(
			chatMessageNotification(mockMessage(), undefined, ME, deriveBlockedUsers([{ userId: 2n, email: "peer@x.io" }]), LABELS)
		).toBeNull()
	})

	it("labels an undecryptable message and bounds a long one", () => {
		const undecryptable = mockMessage()

		delete undecryptable.message

		expect(chatMessageNotification(undecryptable, mockChat(), ME, EMPTY_BLOCKED_USERS, LABELS)?.body).toBe("Unreadable")
		expect(
			chatMessageNotification(mockMessage({ message: "x".repeat(1000) }), mockChat(), ME, EMPTY_BLOCKED_USERS, LABELS)?.body
		).toHaveLength(NOTIFICATION_BODY_MAX_LENGTH)
	})
})
