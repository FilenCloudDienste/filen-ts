import { describe, expect, it, vi } from "vitest"
import { isMessageUnreadCore, chatHasUnreadCore, countUnreadCore, type UnreadMessage, type UnreadChat, type IsSenderBlocked } from "@filen/shared"

// Consolidates the raw-predicate coverage that used to live three times over: mobile's
// chatSelectors.test.ts ("isMessageUnread" + "chatHasUnread"), mobile's
// useChatUnreadCount.test.ts ("isMessageUnread — direct unit tests", a near-verbatim duplicate of
// the former), and web's chatsUnreadLogic.test.ts. Each app keeps only a thin adapter test proving
// its own SDK shape maps correctly.

const SELF = 1n
const OTHER = 2n
const BLOCKED = 99n

const NEVER_BLOCKED: IsSenderBlocked = () => false

function blockedBy(userIds: readonly bigint[] = [], emails: readonly string[] = []): IsSenderBlocked {
	const ids = new Set(userIds)
	const mails = new Set(emails)

	return sender => ids.has(sender.userId) || mails.has(sender.email)
}

function message(overrides: Partial<UnreadMessage> = {}): UnreadMessage {
	return {
		sentTimestamp: 200n,
		senderId: OTHER,
		senderEmail: "other@x.io",
		...overrides
	}
}

function chat(overrides: Partial<UnreadChat> = {}): UnreadChat {
	return {
		muted: false,
		lastFocus: 100n,
		hasLastMessage: true,
		...overrides
	}
}

describe("isMessageUnreadCore", () => {
	it("userId === undefined is NOT unread (settled behaviour — web's guard wins)", () => {
		// The two mobile sources this batch folds in both asserted `true` here (mobile's own predicate
		// had no undefined-userId guard). That is a deliberate INVERSION, not a port: the shared core
		// settles on web's `userId === undefined ⇒ false` guard, since mobile's only caller already
		// passes `?? 0n` and never actually hits this branch.
		expect(isMessageUnreadCore(message(), chat(), undefined, NEVER_BLOCKED)).toBe(false)
	})

	it("false when chat.lastFocus is undefined (never opened)", () => {
		expect(isMessageUnreadCore(message(), chat({ lastFocus: undefined }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when the chat has no lastMessage — the gate is chat-level, not derived from the message argument", () => {
		// Preserved, tested behaviour from mobile's chatSelectors.ts: `hasLastMessage` reflects the
		// CHAT's own lastMessage presence, independent of whichever message is under test.
		expect(isMessageUnreadCore(message(), chat({ hasLastMessage: false }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when the chat is muted", () => {
		expect(isMessageUnreadCore(message(), chat({ muted: true }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when sentTimestamp equals lastFocus (strict greater-than boundary)", () => {
		expect(isMessageUnreadCore(message({ sentTimestamp: 100n }), chat({ lastFocus: 100n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when sentTimestamp is less than lastFocus", () => {
		expect(isMessageUnreadCore(message({ sentTimestamp: 50n }), chat({ lastFocus: 100n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when the sender is the current user", () => {
		expect(isMessageUnreadCore(message({ senderId: SELF }), chat(), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("true when sentTimestamp > lastFocus, sender is someone else, and nobody is blocked", () => {
		expect(isMessageUnreadCore(message({ sentTimestamp: 200n, senderId: OTHER }), chat({ lastFocus: 100n }), SELF, NEVER_BLOCKED)).toBe(
			true
		)
	})

	it("true when lastFocus is 0n (falsy but valid epoch) and sentTimestamp is 1n", () => {
		// 0n must be treated as a real, defined timestamp — not a falsy sentinel.
		expect(isMessageUnreadCore(message({ sentTimestamp: 1n }), chat({ lastFocus: 0n }), SELF, NEVER_BLOCKED)).toBe(true)
	})

	it("false when lastFocus is 0n and sentTimestamp is also 0n (equal, not greater)", () => {
		expect(isMessageUnreadCore(message({ sentTimestamp: 0n }), chat({ lastFocus: 0n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when the sender is blocked by userId", () => {
		expect(isMessageUnreadCore(message({ senderId: BLOCKED }), chat(), SELF, blockedBy([BLOCKED]))).toBe(false)
	})

	it("false when the sender is blocked by email fallback (userId doesn't match)", () => {
		expect(isMessageUnreadCore(message({ senderId: OTHER, senderEmail: "spam@x.com" }), chat(), SELF, blockedBy([], ["spam@x.com"]))).toBe(
			false
		)
	})
})

describe("chatHasUnreadCore", () => {
	it("false when the chat is muted", () => {
		expect(chatHasUnreadCore({ muted: true, lastFocus: 100n }, message({ sentTimestamp: 200n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when there is no lastMessage", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, undefined, SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when lastFocus is undefined (never opened)", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: undefined }, message({ sentTimestamp: 200n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("true when lastFocus is 0n and a newer message from someone else exists", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: 0n }, message({ sentTimestamp: 1n }), SELF, NEVER_BLOCKED)).toBe(true)
	})

	it("false when the last message is from self", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, message({ senderId: SELF, sentTimestamp: 200n }), SELF, NEVER_BLOCKED)).toBe(
			false
		)
	})

	it("false when the last message is older than lastFocus", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: 300n }, message({ sentTimestamp: 200n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("false when the last message's sentTimestamp equals lastFocus (exact boundary)", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: 200n }, message({ sentTimestamp: 200n }), SELF, NEVER_BLOCKED)).toBe(false)
	})

	it("true when someone else sent a newer message after lastFocus", () => {
		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, message({ sentTimestamp: 200n }), SELF, NEVER_BLOCKED)).toBe(true)
	})

	it("is false when no message reader is supplied at all (back-compat)", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: BLOCKED, sentTimestamp: 900n })

		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, lastMessage, SELF, blocked)).toBe(false)
	})

	it("blocked last sender, reader has nothing cached → not unread (never guesses)", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: BLOCKED, sentTimestamp: 200n })

		expect(chatHasUnreadCore({ muted: false, lastFocus: 50n }, lastMessage, SELF, blocked, () => undefined)).toBe(false)
	})

	it("blocked last sender, no OLDER unread among the cached messages → not unread", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: BLOCKED, sentTimestamp: 200n })

		expect(chatHasUnreadCore({ muted: false, lastFocus: 50n }, lastMessage, SELF, blocked, () => [lastMessage])).toBe(false)
	})

	it("blocked last sender, an older unread from a non-blocked sender exists → unread", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: BLOCKED, sentTimestamp: 200n })
		const older = message({ senderId: OTHER, sentTimestamp: 120n })

		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, lastMessage, SELF, blocked, () => [older, lastMessage])).toBe(true)
	})

	it("blocked last sender, every cached message is blocked, own, or already read → not unread", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: BLOCKED, sentTimestamp: 200n })
		const fromBlocked = message({ senderId: BLOCKED, sentTimestamp: 150n })
		const own = message({ senderId: SELF, sentTimestamp: 180n })
		const alreadyRead = message({ senderId: OTHER, sentTimestamp: 50n })

		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, lastMessage, SELF, blocked, () => [fromBlocked, own, alreadyRead])).toBe(
			false
		)
	})

	it("a muted chat never reaches the blocked-sender scan", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: BLOCKED, sentTimestamp: 200n })
		const older = message({ senderId: OTHER, sentTimestamp: 120n })
		const getMessages = vi.fn(() => [older])

		expect(chatHasUnreadCore({ muted: true, lastFocus: 100n }, lastMessage, SELF, blocked, getMessages)).toBe(false)
		expect(getMessages).not.toHaveBeenCalled()
	})

	it("answers on the cheap path without touching the reader when the last sender is not blocked", () => {
		const blocked = blockedBy([BLOCKED])
		const lastMessage = message({ senderId: OTHER, sentTimestamp: 900n })
		const getMessages = vi.fn(() => undefined)

		expect(chatHasUnreadCore({ muted: false, lastFocus: 100n }, lastMessage, SELF, blocked, getMessages)).toBe(true)
		expect(getMessages).not.toHaveBeenCalled()
	})
})

describe("countUnreadCore", () => {
	const blocked = blockedBy([BLOCKED], ["blocked@x.io"])
	const messages: UnreadMessage[] = [
		message({ sentTimestamp: 200n }),
		message({ sentTimestamp: 300n }),
		message({ sentTimestamp: 100n }),
		message({ sentTimestamp: 50n }),
		message({ senderId: SELF, sentTimestamp: 400n }),
		message({ senderId: BLOCKED, sentTimestamp: 500n }),
		message({ senderId: 3n, senderEmail: "blocked@x.io", sentTimestamp: 600n }),
		message({ senderId: 4n, senderEmail: "fine@x.io", sentTimestamp: 700n })
	]

	function count(c: UnreadChat, userId: bigint | undefined, isSenderBlocked: IsSenderBlocked): number {
		return countUnreadCore(
			messages,
			c,
			userId,
			m => m.sentTimestamp,
			m => m.senderId,
			m => isSenderBlocked({ userId: m.senderId, email: m.senderEmail })
		)
	}

	const cases: Array<[string, UnreadChat, bigint | undefined, IsSenderBlocked]> = [
		["plain", chat(), SELF, blocked],
		["nothing blocked", chat(), SELF, NEVER_BLOCKED],
		["muted", chat({ muted: true }), SELF, blocked],
		["no lastFocus", chat({ lastFocus: undefined }), SELF, blocked],
		["no lastMessage", chat({ hasLastMessage: false }), SELF, blocked],
		["no user", chat(), undefined, blocked],
		["other viewer", chat(), OTHER, blocked],
		["everything older than lastFocus", chat({ lastFocus: 10_000n }), SELF, blocked]
	]

	it.each(cases)("matches the isMessageUnreadCore filter: %s", (_, c, userId, isSenderBlocked) => {
		expect(count(c, userId, isSenderBlocked)).toBe(messages.filter(m => isMessageUnreadCore(m, c, userId, isSenderBlocked)).length)
	})

	it("counts newer messages from unblocked others only", () => {
		expect(count(chat(), SELF, blocked)).toBe(3)
	})

	it("asks about blocking only for messages that pass the cheap checks", () => {
		const isMessageSenderBlocked = vi.fn(() => false)

		countUnreadCore(messages, chat(), SELF, m => m.sentTimestamp, m => m.senderId, isMessageSenderBlocked)

		expect(isMessageSenderBlocked).toHaveBeenCalledTimes(5)
	})

	it("never reads a message when the chat gate rejects", () => {
		const getSentTimestamp = vi.fn((m: UnreadMessage) => m.sentTimestamp)

		expect(countUnreadCore(messages, chat({ muted: true }), SELF, getSentTimestamp, m => m.senderId, () => false)).toBe(0)
		expect(getSentTimestamp).not.toHaveBeenCalled()
	})
})
