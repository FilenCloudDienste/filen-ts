import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import {
	buildChatList,
	chatsInExpandedSections,
	chatsWithoutBlockedOneOnOne,
	filterChats,
	staleChatSelectionUuids
} from "@/features/chats/components/chatsSidebar.logic"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { deriveBlockedUsers } from "@filen/shared"
import { mockPlainBlockedContact } from "@/tests/support/contactFixtures"
import { testUuid } from "@/tests/support/uuid"
import {
	mockChat as fixtureChat,
	mockChatMessage,
	mockChatParticipant,
	mockUndecryptableChat as fixtureUndecryptableChat
} from "@/tests/fixtures/sdk"

function mockParticipant(overrides: Partial<ChatParticipant> = {}): ChatParticipant {
	return mockChatParticipant({ userId: 1n, email: "a@example.com", ...overrides })
}

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return mockChatMessage({ senderId: 2, senderEmail: "b@example.com", sentTimestamp: 1_000n, ...overrides })
}

function mockChat(label: string, overrides: Partial<Chat> = {}): Chat {
	return fixtureChat({ uuid: testUuid(label), participants: [mockParticipant()], ...overrides })
}

function mockUndecryptableChat(label: string, overrides: Omit<Partial<Chat>, "key"> = {}): Chat {
	return fixtureUndecryptableChat({ uuid: testUuid(label), participants: [mockParticipant()], ...overrides })
}

const SELF = 1n
// The rendered title of a chat with no other participants — threaded through filterChats so search
// matches what the row displays (chatDisplayName's soloFallback).
const SOLO = "Just you"

describe("filterChats", () => {
	it("returns the full sorted list for an empty search term", () => {
		const older = mockChat("a", { lastMessage: mockMessage({ sentTimestamp: 100n }) })
		const newer = mockChat("b", { lastMessage: mockMessage({ sentTimestamp: 200n }) })

		// Newest lastMessage first, independent of input order.
		expect(filterChats([older, newer], "", SELF, SOLO).map(c => c.uuid)).toEqual([newer.uuid, older.uuid])
	})

	it("matches on the conversation display name", () => {
		const named = mockChat("a", { name: "Weekend Plans" })
		const other = mockChat("b", { name: "Work" })

		expect(filterChats([named, other], "weekend", SELF, SOLO).map(c => c.uuid)).toEqual([named.uuid])
	})

	it("matches on a participant email or nickname", () => {
		const chat = mockChat("a", {
			name: "Untitled",
			participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n, email: "zoe@example.com" })]
		})

		expect(filterChats([chat], "zoe@", SELF, SOLO).map(c => c.uuid)).toEqual([chat.uuid])
	})

	it("excludes undecryptable conversations from a term match but keeps them for an empty search", () => {
		const undecryptable = mockUndecryptableChat("a")

		expect(filterChats([undecryptable], "", SELF, SOLO).map(c => c.uuid)).toEqual([undecryptable.uuid])
		expect(filterChats([undecryptable], "anything", SELF, SOLO)).toEqual([])
	})

	// A chat with no other participants renders the solo-fallback title — searching that exact text
	// must find it, same as any other displayed name.
	it("matches a solo chat (every other participant left) on its rendered fallback title", () => {
		const solo = mockChat("a", { participants: [mockParticipant({ userId: SELF })], lastMessage: mockMessage() })
		const other = mockChat("b", { name: "Work", lastMessage: mockMessage() })

		expect(filterChats([solo, other], "just you", SELF, SOLO).map(c => c.uuid)).toEqual([solo.uuid])
	})

	// Search also matches the conversation's last-message text (name/email/nickname already covered
	// above), same as mobile's list search.
	it("matches on the last-message text", () => {
		const chat = mockChat("a", { name: "Untitled", lastMessage: mockMessage({ message: "let's meet at noon" }) })
		const other = mockChat("b", { name: "Other", lastMessage: mockMessage({ message: "unrelated" }) })

		expect(filterChats([chat, other], "meet at noon", SELF, SOLO).map(c => c.uuid)).toEqual([chat.uuid])
	})

	// A chat the viewer merely joined (not owned) and that has never had a message is hidden from
	// the list entirely; an owned-but-empty chat, or any chat with at least one message regardless of
	// ownership, still shows. Applies to both the empty-search and term-search paths.
	describe("owned-or-has-a-message visibility", () => {
		it("hides a chat with no messages that the viewer does not own", () => {
			const invitedEmpty = mockChat("a", { ownerId: 2n })

			expect(filterChats([invitedEmpty], "", SELF, SOLO)).toEqual([])
		})

		it("keeps an owned chat even with no messages yet", () => {
			const ownedEmpty = mockChat("a", { ownerId: SELF })

			expect(filterChats([ownedEmpty], "", SELF, SOLO).map(c => c.uuid)).toEqual([ownedEmpty.uuid])
		})

		it("keeps a non-owned chat once it has at least one message", () => {
			const invitedWithMessage = mockChat("a", { ownerId: 2n, lastMessage: mockMessage() })

			expect(filterChats([invitedWithMessage], "", SELF, SOLO).map(c => c.uuid)).toEqual([invitedWithMessage.uuid])
		})

		it("hides an unowned, message-less chat from a term search too, not just the empty-search list", () => {
			const invitedEmpty = mockChat("a", { ownerId: 2n, name: "Weekend Plans" })

			expect(filterChats([invitedEmpty], "weekend", SELF, SOLO)).toEqual([])
		})

		it("treats an unresolved current-user id as not-owner, hiding message-less chats", () => {
			const chat = mockChat("a", { ownerId: 1n })

			expect(filterChats([chat], "", undefined, SOLO)).toEqual([])
		})
	})
})

describe("chatHasUnread (client-derived)", () => {
	it("is true when the last message is from another sender and newer than lastFocus", () => {
		const chat = mockChat("a", { lastFocus: 500n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })

		expect(chatHasUnread(chat, SELF)).toBe(true)
	})

	it("is false when the last message is not newer than lastFocus", () => {
		const chat = mockChat("a", { lastFocus: 900n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 500n }) })

		expect(chatHasUnread(chat, SELF)).toBe(false)
	})

	it("is false for our own last message (senderId coerced from number to bigint)", () => {
		const chat = mockChat("a", { lastFocus: 0n, lastMessage: mockMessage({ senderId: 1, sentTimestamp: 900n }) })

		expect(chatHasUnread(chat, SELF)).toBe(false)
	})

	it("is false when muted, when there is no last message, or when the user is unknown", () => {
		const muted = mockChat("a", { muted: true, lastFocus: 0n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })
		const noMessage = mockChat("b", { lastFocus: 0n })
		const withUnread = mockChat("c", { lastFocus: 0n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })

		expect(chatHasUnread(muted, SELF)).toBe(false)
		expect(chatHasUnread(noMessage, SELF)).toBe(false)
		expect(chatHasUnread(withUnread, undefined)).toBe(false)
	})
})

describe("chatsWithoutBlockedOneOnOne", () => {
	it("removes only the blocked 1:1 chat and preserves input order", () => {
		const blocked = deriveBlockedUsers([mockPlainBlockedContact({ userId: 9n })])
		const group = mockChat("a", {
			participants: [mockParticipant({ userId: SELF }), mockParticipant({ userId: 9n }), mockParticipant({ userId: 3n })]
		})
		const blockedOneOnOne = mockChat("b", { participants: [mockParticipant({ userId: SELF }), mockParticipant({ userId: 9n })] })
		const plain = mockChat("c", { participants: [mockParticipant({ userId: SELF }), mockParticipant({ userId: 3n })] })

		expect(chatsWithoutBlockedOneOnOne([group, blockedOneOnOne, plain], SELF, blocked).map(c => c.uuid)).toEqual([
			group.uuid,
			plain.uuid
		])
	})

	it("returns the input list unchanged when the blocked argument is omitted", () => {
		const chat = mockChat("a", { participants: [mockParticipant({ userId: SELF }), mockParticipant({ userId: 9n })] })

		expect(chatsWithoutBlockedOneOnOne([chat], SELF).map(c => c.uuid)).toEqual([chat.uuid])
	})
})

describe("filterChats blocked last-message search", () => {
	// A group chat is never hidden wholesale, so its blocked member's last message stays on the chat —
	// but the text the row substitutes with "Message hidden" must not remain searchable.
	function groupWithBlockedLastMessage(): Chat {
		return mockChat("a", {
			name: "Team",
			participants: [
				mockParticipant({ userId: SELF }),
				mockParticipant({ userId: 9n, email: "zoe@example.com", nickName: "Zoe" }),
				mockParticipant({ userId: 3n })
			],
			lastMessage: mockMessage({ senderId: 9, senderEmail: "zoe@example.com", message: "secret plan text" })
		})
	}

	const blocked = deriveBlockedUsers([mockPlainBlockedContact({ userId: 9n, email: "zoe@example.com" })])

	it("does not match a term drawn from a blocked sender's last message", () => {
		expect(filterChats([groupWithBlockedLastMessage()], "secret plan", SELF, SOLO, blocked)).toEqual([])
	})

	it("still matches that chat by display name and by a participant's email or nickname", () => {
		const chat = groupWithBlockedLastMessage()

		expect(filterChats([chat], "team", SELF, SOLO, blocked).map(c => c.uuid)).toEqual([chat.uuid])
		expect(filterChats([chat], "zoe@example", SELF, SOLO, blocked).map(c => c.uuid)).toEqual([chat.uuid])
		expect(filterChats([chat], "zoe", SELF, SOLO, blocked).map(c => c.uuid)).toEqual([chat.uuid])
	})

	it("reproduces today's behaviour exactly when the blocked argument is omitted", () => {
		const chat = groupWithBlockedLastMessage()

		expect(filterChats([chat], "secret plan", SELF, SOLO).map(c => c.uuid)).toEqual([chat.uuid])
	})
})

describe("staleChatSelectionUuids", () => {
	it("returns the uuids of selected chats no longer present in the live set", () => {
		const chatA = mockChat("a")
		const chatB = mockChat("b")

		// chatB was deleted/left elsewhere (a conversationDeleted socket event, or another tab) — it's
		// still in the selection but no longer in the live chats query result.
		expect(staleChatSelectionUuids([chatA, chatB], [chatA.uuid])).toEqual([chatB.uuid])
	})

	it("returns an empty array when every selected chat is still live", () => {
		const chatA = mockChat("a")
		const chatB = mockChat("b")

		expect(staleChatSelectionUuids([chatA, chatB], [chatA.uuid, chatB.uuid])).toEqual([])
	})

	it("returns an empty array for an empty selection", () => {
		expect(staleChatSelectionUuids([], [mockChat("a").uuid])).toEqual([])
	})

	it("treats every selected chat as stale when the live set is empty", () => {
		const chatA = mockChat("a")
		const chatB = mockChat("b")

		expect(staleChatSelectionUuids([chatA, chatB], [])).toEqual([chatA.uuid, chatB.uuid])
	})

	// The caller keys its effect on a joined uuid signature and splits it back apart, so an empty
	// signature arrives as [""] — no live chat can carry that uuid, so the whole selection is stale.
	it("treats an empty-signature live set as no live chats at all", () => {
		const chatA = mockChat("a")

		expect(staleChatSelectionUuids([chatA], "".split(","))).toEqual([chatA.uuid])
	})
})

describe("buildChatList", () => {
	const dm = mockChat("dm", { participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n })] })
	const solo = mockChat("solo")
	const group = mockChat("group", {
		participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n }), mockParticipant({ userId: 3n })]
	})
	const expanded = { direct: false, groups: false }

	function shape(items: ReturnType<typeof buildChatList>["items"]): string[] {
		return items.map(item => (item.kind === "header" ? `${item.section}:${String(item.expanded)}` : item.chat.uuid))
	}

	it("sorts conversations into direct messages then groups, each keeping the incoming order", () => {
		const list = buildChatList([group, dm, solo], expanded, false)

		expect(shape(list.items)).toEqual(["direct:true", dm.uuid, solo.uuid, "groups:true", group.uuid])
		expect(list.chats).toEqual([dm, solo, group])
		expect(list.headerIndexes).toEqual([0, 3])
	})

	it("numbers each conversation within its section and within the on-screen order", () => {
		const items = buildChatList([group, dm, solo], expanded, false).items.filter(item => item.kind === "chat")

		expect(items.map(item => [item.index, item.posInSet, item.setSize])).toEqual([
			[0, 1, 2],
			[1, 2, 2],
			[2, 1, 1]
		])
	})

	it("drops a collapsed section's conversations but keeps its header", () => {
		const list = buildChatList([group, dm], { direct: true, groups: false }, false)

		expect(shape(list.items)).toEqual(["direct:false", "groups:true", group.uuid])
		expect(list.chats).toEqual([group])
		expect(list.headerIndexes).toEqual([0, 1])
	})

	it("shows every section expanded while searching", () => {
		expect(buildChatList([group, dm], { direct: true, groups: true }, true).chats).toEqual([dm, group])
	})

	it("gives an empty section no header", () => {
		expect(shape(buildChatList([group], expanded, false).items)).toEqual(["groups:true", group.uuid])
		expect(buildChatList([], expanded, false)).toEqual({ items: [], chats: [], headerIndexes: [] })
	})
})

describe("chatsInExpandedSections", () => {
	const dm = mockChat("dm", { participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n })] })
	const group = mockChat("group", {
		participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n }), mockParticipant({ userId: 3n })]
	})
	const directCollapsed = { direct: true, groups: false }

	function stale(selected: readonly Chat[], selectable: readonly Chat[]): string[] {
		return staleChatSelectionUuids(
			selected,
			selectable.map(chat => chat.uuid)
		)
	}

	it("leaves a collapsed section's conversations out", () => {
		expect(chatsInExpandedSections([dm, group], directCollapsed, false)).toEqual([group])
		expect(chatsInExpandedSections([dm, group], { direct: false, groups: false }, false)).toEqual([dm, group])
	})

	it("holds every section while searching, and drops a collapsed one's selection once the search ends", () => {
		// Selected during a search, which unfolds the collapsed direct section.
		expect(stale([dm, group], chatsInExpandedSections([dm, group], directCollapsed, true))).toEqual([])
		// The search ends: the direct section folds away again, and its conversation with it.
		expect(stale([dm, group], chatsInExpandedSections([dm, group], directCollapsed, false))).toEqual([dm.uuid])
	})

	it("drops a selected conversation that moves into a collapsed section", () => {
		const shrunk = { ...group, participants: group.participants.slice(0, 2) }

		expect(stale([group], chatsInExpandedSections([shrunk], { direct: true, groups: false }, false))).toEqual([group.uuid])
	})
})
