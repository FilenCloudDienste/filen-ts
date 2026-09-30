// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
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

import { ChatRow } from "@/features/chats/components/chatRow"
import { testUuid } from "@/tests/support/uuid"

function mockParticipant(userId: bigint, email: string): ChatParticipant {
	return { userId, email, nickName: undefined, permissionsAdd: false, added: 0n, appearOffline: false, lastActive: 0n }
}

const chat: Chat = {
	uuid: testUuid("chat"),
	ownerId: 1n,
	key: "chat-key",
	participants: [mockParticipant(1n, "me@example.com"), mockParticipant(2n, "zoe@example.com")],
	muted: false,
	created: 0n,
	lastFocus: 0n
}

function renderRow(overrides: { selected?: boolean; beforeSelected?: boolean } = {}) {
	return render(
		createElement(ChatRow, {
			chat,
			selected: overrides.selected ?? false,
			multiSelected: false,
			beforeSelected: overrides.beforeSelected ?? false,
			posInSet: 1,
			setSize: 1,
			currentUserId: 1n,
			blocked: EMPTY_BLOCKED_USERS,
			onAction: () => undefined,
			onPointerSelect: () => undefined
		})
	)
}

afterEach(() => {
	cleanup()
	unreadCount.value = 0
})

describe("ChatRow", () => {
	it("announces the unread count on the dot instead of a numeric badge", () => {
		unreadCount.value = 3
		renderRow()

		expect(screen.getByRole("img", { name: "3 unread messages" })).toBeTruthy()
		expect(screen.queryByText("3")).toBeNull()
	})

	it("reserves the dot's space without announcing it when read", () => {
		const { container } = renderRow()

		expect(screen.queryByRole("img", { name: /unread/ })).toBeNull()
		expect(container.querySelector('[aria-hidden="true"].size-2\\.5')).toBeTruthy()
	})

	it("fills the routed row and drops the separators around it", () => {
		const selected = renderRow({ selected: true })
		const option = selected.getByRole("option")

		expect(option.className).toContain("bg-chat-own")
		expect(option.className).toContain("after:hidden")
		expect(selected.getByRole("link").getAttribute("aria-current")).toBe("page")
		selected.unmount()

		expect(renderRow({ beforeSelected: true }).getByRole("option").className).toContain("after:hidden")
	})

	it("keeps the separator on an ordinary row", () => {
		const option = renderRow().getByRole("option")

		expect(option.className).not.toContain("after:hidden")
		expect(option.className).not.toContain("bg-chat-own")
	})
})
