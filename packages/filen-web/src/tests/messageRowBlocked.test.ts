// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Chat, ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"

// The store (chatsRevealedBlockedMessages.test.ts) and isBlocked (blocking.test.ts) are both pinned; the
// row that combines them into the tombstone is not, and that combination is the whole feature: a blocked
// sender's message body, name, avatar, action bar and menu must all be gone until the reader asks for
// them. Rendered rather than probed through a seam because "replaces the ENTIRE row subtree" is the
// property under test.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import "@/lib/i18n"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"
import { useRevealedBlockedMessages } from "@/features/chats/store/useRevealedBlockedMessages"
import { MessageRow } from "@/features/chats/components/thread/messageRow"

const BLOCKED_ID = 42n
const BLOCKED_EMAIL = "blocked@example.com"
const MESSAGE_UUID = "22222222-2222-2222-2222-222222222222"

const chat = {
	uuid: "11111111-1111-1111-1111-111111111111",
	ownerId: 1n,
	participants: [{ userId: 1n }, { userId: BLOCKED_ID }]
} as unknown as Chat

const blocked: BlockedUsers = deriveBlockedUsers([{ userId: BLOCKED_ID, email: BLOCKED_EMAIL, uuid: "b", timestamp: 0n }] as never)

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: MESSAGE_UUID,
		senderId: BLOCKED_ID,
		senderEmail: BLOCKED_EMAIL,
		senderNickName: "Mallory",
		senderAvatar: undefined,
		message: "secret payload",
		replyTo: undefined,
		embedDisabled: true,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1_700_000_000_000n,
		...overrides
	} as unknown as ChatMessage
}

// A revealed row mounts MessageEmbeds, whose link-preview read needs a client of its own.
function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }), children })
}

function renderRow(overrides: Partial<ChatMessage> = {}, blockedUsers: BlockedUsers = blocked) {
	return render(
		createElement(MessageRow, {
			chat,
			message: message(overrides),
			showHeader: true,
			currentUserId: 1n,
			blocked: blockedUsers
		}),
		{ wrapper }
	)
}

beforeEach(() => {
	useRevealedBlockedMessages.setState({ revealed: new Set<string>() })
})

afterEach(cleanup)

describe("MessageRow — blocked sender tombstone", () => {
	it("withholds the whole row for a blocked sender: no body, no name, no avatar, no action bar", () => {
		renderRow()

		expect(screen.getByText("Message hidden")).toBeDefined()
		expect(screen.getByRole("button", { name: /show/i })).toBeDefined()
		expect(screen.queryByText("secret payload")).toBeNull()
		expect(screen.queryByText("Mallory")).toBeNull()
		expect(screen.queryByText("M")).toBeNull()
	})

	it("reveals that one message — and only that one — when the reader asks", () => {
		renderRow()

		fireEvent.click(screen.getByRole("button", { name: /show/i }))

		expect([...useRevealedBlockedMessages.getState().revealed]).toEqual([MESSAGE_UUID])
		expect(screen.getByText("secret payload")).toBeDefined()
		expect(screen.getByText("Mallory")).toBeDefined()
	})

	it("never hides a sender who is not blocked, revealed or not", () => {
		renderRow({ senderId: 7n as never, senderEmail: "friend@example.com" }, blocked)

		expect(screen.getByText("secret payload")).toBeDefined()
		expect(screen.queryByText("Message hidden")).toBeNull()
	})

	it("an empty blocked set hides nothing — the fail-open default while the contacts read is disabled", () => {
		renderRow({}, EMPTY_BLOCKED_USERS)

		expect(screen.getByText("secret payload")).toBeDefined()
	})

	// A reveal in the store must never CAUSE anything: it is only ever a per-uuid exemption.
	it("a revealed uuid does not resurrect anything for an unblocked sender", () => {
		useRevealedBlockedMessages.setState({ revealed: new Set([MESSAGE_UUID]) })
		renderRow({}, EMPTY_BLOCKED_USERS)

		expect(screen.getByText("secret payload")).toBeDefined()
		expect(screen.queryByText("Message hidden")).toBeNull()
	})
})

describe("MessageRow — reply to a blocked sender", () => {
	const replyTo = {
		uuid: "33333333-3333-3333-3333-333333333333",
		senderId: Number(BLOCKED_ID),
		senderEmail: BLOCKED_EMAIL,
		senderNickName: "Mallory",
		message: "quoted secret",
		sentTimestamp: 1_700_000_000_000n
	} as unknown as ChatMessagePartial

	// The row's own sender is NOT blocked, so the tombstone above never covers it — rendering the quote
	// verbatim would republish exactly the name and text the tombstone withholds.
	it("redacts the quoted preview inside an unblocked sender's row", () => {
		renderRow({ senderId: 7n as never, senderEmail: "friend@example.com", replyTo })

		expect(screen.getByText("Message hidden")).toBeDefined()
		expect(screen.queryByText("quoted secret")).toBeNull()
		expect(screen.queryByText(/Replying to/)).toBeNull()
		// The row's own message still renders — only the quote is redacted.
		expect(screen.getByText("secret payload")).toBeDefined()
	})

	it("keeps the quote intact when its sender is not blocked", () => {
		renderRow(
			{
				senderId: 7n as never,
				senderEmail: "friend@example.com",
				replyTo: { ...replyTo, senderId: 8, senderEmail: "other@example.com" }
			},
			blocked
		)

		expect(screen.getByText("quoted secret")).toBeDefined()
		expect(screen.queryByText("Message hidden")).toBeNull()
	})
})
