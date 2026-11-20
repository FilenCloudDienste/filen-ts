// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import { deriveBlockedUsers } from "@filen/shared"
import type { ChatMessage } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/chats/components/thread/useMessageActions", () => ({
	useMessageActions: () => ({ descriptors: [], runAction: vi.fn() })
}))
vi.mock("@/features/chats/components/thread/messageEmbeds", () => ({ MessageEmbeds: () => null }))

import "@/lib/i18n"
import { MessageRow } from "@/features/chats/components/thread/messageRow"
import { mockChat, mockChatMessage, mockChatParticipant } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

const ME = 1n
const chat = mockChat({
	participants: [
		mockChatParticipant({ userId: ME, email: "me@x.io" }),
		mockChatParticipant({ userId: 2n, email: "bob@x.io", nickName: "Bob" })
	]
})

function renderRow(message: ChatMessage): HTMLElement {
	const { container } = render(
		createElement(MessageRow, {
			chat,
			message,
			runStart: true,
			currentUserId: ME,
			ownAvatarUrl: undefined,
			blocked: deriveBlockedUsers([]),
			active: false,
			actionsRef: null,
			replying: false
		})
	)
	const row = container.querySelector("[data-message-focus]")

	if (!(row instanceof HTMLElement)) {
		throw new Error("no message row")
	}

	return row
}

afterEach(() => {
	cleanup()
})

describe("MessageRow addressed to the reader", () => {
	it("tints a message that mentions the reader, says so to assistive technology and keeps the mention styled", () => {
		const row = renderRow(mockChatMessage({ chat: chat.uuid, senderId: 2, message: "ping @me@x.io" }))

		expect(row.className).toContain("bg-chat-own/8")
		expect(row.className).toContain("before:bg-chat-own")
		expect(screen.getByText("Mentions you").className).toContain("sr-only")
		expect(screen.getByText("@me@x.io").className).toContain("font-medium")
	})

	it("tints a reply to the reader's message", () => {
		const row = renderRow(
			mockChatMessage({
				chat: chat.uuid,
				senderId: 2,
				message: "sure",
				replyTo: { uuid: testUuid("r"), senderId: Number(ME), senderEmail: "me@x.io", senderNickName: undefined, message: "q" }
			})
		)

		expect(row.className).toContain("bg-chat-own/8")
		expect(screen.getByText("Replies to you")).toBeTruthy()
	})

	it("leaves other messages plain", () => {
		const row = renderRow(mockChatMessage({ chat: chat.uuid, senderId: 2, message: "ping @bob@x.io" }))

		expect(row.className).not.toContain("bg-chat-own")
		expect(screen.queryByText("Mentions you")).toBeNull()
	})

	it("leaves the reader's own @everyone plain", () => {
		const row = renderRow(mockChatMessage({ chat: chat.uuid, senderId: Number(ME), message: "@everyone hi" }))

		expect(row.className).not.toContain("bg-chat-own")
	})
})
