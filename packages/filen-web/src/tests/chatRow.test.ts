// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"
import "@/lib/i18n"

const { unreadCount } = vi.hoisted(() => ({ unreadCount: { value: 0 } }))

// The row's Link is its only router surface; stubbed down to the anchor it renders.
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, params: _params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode }) =>
		createElement("a", { ...rest, href: to }, children),
	useNavigate: () => () => undefined,
	useRouterState: () => ""
}))

vi.mock("@/features/chats/hooks/useChatUnreadCount", () => ({ useChatUnreadCount: () => unreadCount.value }))
vi.mock("@/features/chats/hooks/useChatTyping", () => ({ useChatTypingLabel: () => null }))

import { ChatRow, type ChatRowProps } from "@/features/chats/components/chatRow"
import { touchLongPress, touchTap } from "@/tests/support/touch"
import { mockChat, mockChatMessage, mockChatParticipant } from "@/tests/fixtures/sdk"

function mockParticipant(userId: bigint, email: string): ChatParticipant {
	return mockChatParticipant({ userId, email })
}

const chat = mockChat({ participants: [mockParticipant(1n, "me@example.com"), mockParticipant(2n, "zoe@example.com")] })

function lastMessage(senderId: number, senderEmail: string): ChatMessage {
	return mockChatMessage({ senderId, senderEmail, chat: chat.uuid, sentTimestamp: 1_000n })
}

function renderRow(
	overrides: { selected?: boolean; multiSelected?: boolean; chat?: Chat } & Partial<
		Pick<ChatRowProps, "onPointerSelect" | "onLongPress">
	> = {}
) {
	return render(
		createElement(ChatRow, {
			chat: overrides.chat ?? chat,
			selected: overrides.selected ?? false,
			multiSelected: overrides.multiSelected ?? false,
			posInSet: 1,
			setSize: 1,
			currentUserId: 1n,
			blocked: EMPTY_BLOCKED_USERS,
			onAction: () => undefined,
			onPointerSelect: overrides.onPointerSelect ?? (() => false),
			onLongPress: overrides.onLongPress ?? (() => undefined)
		})
	)
}

afterEach(() => {
	cleanup()
	unreadCount.value = 0
	vi.useRealTimers()
})

describe("ChatRow", () => {
	it("shows the unread count in a pill, announced in words, and bolds the name", () => {
		unreadCount.value = 3
		renderRow()

		expect(screen.getByText("3").getAttribute("aria-hidden")).toBe("true")
		expect(screen.getByText("3 unread messages").className).toContain("sr-only")
		expect(screen.getByText("zoe@example.com").className).toContain("font-semibold")
	})

	it("caps the pill's count", () => {
		unreadCount.value = 120
		renderRow()

		expect(screen.getByText("99+")).toBeTruthy()
		expect(screen.getByText("120 unread messages")).toBeTruthy()
	})

	it("shows no pill when read", () => {
		renderRow()

		expect(screen.queryByText(/unread/)).toBeNull()
		expect(screen.getByText("zoe@example.com").className).not.toContain("font-semibold")
	})

	it("fills the routed row", () => {
		const selected = renderRow({ selected: true })

		expect(selected.getByRole("option").classList).toContain("bg-sidebar-accent")
		expect(selected.getByRole("link").getAttribute("aria-current")).toBe("page")
		selected.unmount()

		expect(renderRow().getByRole("option").classList).not.toContain("bg-sidebar-accent")
	})

	it("rings a multi-selection in a neutral token, never the brand blue", () => {
		const option = renderRow({ multiSelected: true }).getByRole("option")

		expect(option.classList).toContain("ring-primary/60")
		expect(option.className).not.toContain("chat-own")
		cleanup()

		expect(renderRow().getByRole("option").className).not.toContain("ring-2")
	})

	it("focuses its link with the neutral keyboard-only row ring", () => {
		expect(renderRow().getByRole("link").classList).toContain("focus-ring-row")
	})

	// jsdom applies no CSS: this pins that the highlight follows Base UI's open-trigger attribute, which the row carries
	// while its context menu is open, and its ⋯ trigger while that menu is.
	it("holds the hover highlight while its context menu is open", async () => {
		const option = renderRow().getByRole("option")

		expect(option.classList).toContain("data-popup-open:bg-sidebar-accent/60")
		expect(option.classList).toContain("has-[[data-popup-open]]:bg-sidebar-accent/60")
		expect(option.hasAttribute("data-popup-open")).toBe(false)

		fireEvent.contextMenu(option)
		await screen.findByRole("menu")

		expect(option.hasAttribute("data-popup-open")).toBe(true)
	})

	it("prefixes the preview with You on own messages, never with the other person in a 1:1", () => {
		renderRow({ chat: { ...chat, lastMessage: lastMessage(1, "me@example.com") } })
		expect(screen.getByText("You: hi")).toBeTruthy()
		cleanup()

		renderRow({ chat: { ...chat, lastMessage: lastMessage(2, "zoe@example.com") } })
		expect(screen.getByText("hi")).toBeTruthy()
	})

	it("prefixes the preview with its sender in a group", () => {
		const group: Chat = {
			...chat,
			participants: [...chat.participants, mockParticipant(3n, "max@example.com")],
			lastMessage: lastMessage(3, "max@example.com")
		}

		renderRow({ chat: group })
		expect(screen.getByText("max@example.com: hi")).toBeTruthy()
	})
})

describe("ChatRow — touch", () => {
	it("hands a tap's pointer type to the selection, and a long-press to its toggle without navigating", () => {
		vi.useFakeTimers()

		const onPointerSelect = vi.fn<ChatRowProps["onPointerSelect"]>(() => false)
		const onLongPress = vi.fn()

		renderRow({ onPointerSelect, onLongPress })

		const link = screen.getByRole("link")

		expect(touchTap(link)).toBe(true)
		expect(touchLongPress(link)).toBe(false)
		expect(onPointerSelect.mock.calls.map(call => call[1])).toEqual(["touch"])
		expect(onLongPress).toHaveBeenCalledOnce()
		expect(screen.queryByRole("menu")).toBeNull()
	})
})
