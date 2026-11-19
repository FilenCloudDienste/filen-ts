// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"

// The sidebar's virtualized list re-renders on every range change (useVirtualizer opts it out of the React
// Compiler). A conversation row that stays mounted across a range change must not render again, and a selection
// change renders only the row whose selection flipped. Row renders are counted through the row's typing-label hook,
// which runs once per ChatRow render.

const { rowRenders } = vi.hoisted(() => ({ rowRenders: new Map<string, number>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, params: _params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode }) =>
		createElement("a", { ...rest, href: to }, children),
	useNavigate: () => () => undefined,
	useRouterState: () => ""
}))
vi.mock("@/features/chats/hooks/useChatUnreadCount", () => ({ useChatUnreadCount: () => 0 }))
vi.mock("@/features/chats/hooks/useChatTyping", () => ({
	useChatTypingLabel: (chatUuid: string) => {
		rowRenders.set(chatUuid, (rowRenders.get(chatUuid) ?? 0) + 1)

		return null
	}
}))

import "@/lib/i18n"
import { ChatsVirtualList, type ChatsVirtualListProps } from "@/features/chats/components/chatsSidebar"
import { buildChatList } from "@/features/chats/components/chatsSidebar.logic"
import { testUuid } from "@/tests/support/uuid"
import { mockChat, mockChatParticipant } from "@/tests/fixtures/sdk"

const VIEWPORT_HEIGHT = 300
const ROW_HEIGHT = 48

function participant(userId: bigint): ChatParticipant {
	return mockChatParticipant({ userId, email: `u${String(userId)}@filen.io` })
}

function chat(i: number): Chat {
	return mockChat({ uuid: testUuid(`chat${String(i)}`), participants: [participant(1n), participant(BigInt(100 + i))] })
}

const chats = Array.from({ length: 60 }, (_, i) => chat(i))
const list = buildChatList(chats, { direct: false, groups: false }, false)

function scrollElement(): HTMLDivElement {
	const el = document.createElement("div")

	Object.defineProperty(el, "clientHeight", { configurable: true, value: VIEWPORT_HEIGHT })
	Object.defineProperty(el, "clientWidth", { configurable: true, value: 300 })
	Object.defineProperty(el, "offsetHeight", { configurable: true, value: VIEWPORT_HEIGHT })
	document.body.appendChild(el)

	return el
}

function props(
	el: HTMLDivElement,
	liveSelectedUuids: ReadonlySet<string>,
	callbacks: Pick<ChatsVirtualListProps, "onAction" | "onPointerSelect" | "onToggleSelect">
): ChatsVirtualListProps {
	return {
		items: list.items,
		headerIndexes: list.headerIndexes,
		searching: false,
		scrollElement: el,
		fallback: null,
		label: "Chats",
		sectionLabels: { direct: "Direct", groups: "Groups" },
		onToggleSection: () => undefined,
		selectedUuid: "",
		liveSelectedUuids,
		currentUserId: 1n,
		blocked: EMPTY_BLOCKED_USERS,
		...callbacks
	}
}

afterEach(() => {
	cleanup()
	rowRenders.clear()
	document.body.replaceChildren()
})

describe("ChatsVirtualList — row renders", () => {
	it("does not render a row again when a range change keeps it mounted", () => {
		const el = scrollElement()
		const callbacks = { onAction: vi.fn(), onPointerSelect: vi.fn(() => false), onToggleSelect: vi.fn() }

		render(createElement(ChatsVirtualList, props(el, new Set<string>(), callbacks)), { container: el })

		const kept = chats[3]?.uuid ?? ""
		const far = chats[25]?.uuid ?? ""

		expect(rowRenders.get(kept)).toBe(1)
		expect(rowRenders.has(far)).toBe(false)

		act(() => {
			el.scrollTop = ROW_HEIGHT * 10
			fireEvent.scroll(el)
		})

		// The range moved: a row further down mounted, the kept one rendered no second time.
		expect(rowRenders.get(far)).toBe(1)
		expect(rowRenders.get(kept)).toBe(1)
	})

	it("re-renders only the row whose selection flipped", () => {
		const el = scrollElement()
		const callbacks = { onAction: vi.fn(), onPointerSelect: vi.fn(() => false), onToggleSelect: vi.fn() }
		const { rerender } = render(createElement(ChatsVirtualList, props(el, new Set<string>(), callbacks)), { container: el })
		const before = new Map(rowRenders)
		const toggled = chats[2]?.uuid ?? ""

		rerender(createElement(ChatsVirtualList, props(el, new Set([toggled]), callbacks)))

		for (const [uuid, count] of rowRenders) {
			expect(count).toBe((before.get(uuid) ?? 0) + (uuid === toggled ? 1 : 0))
		}
	})

	it("routes a row's handlers to the newest callbacks with the row's index", () => {
		const el = scrollElement()
		const first = { onAction: vi.fn(), onPointerSelect: vi.fn(() => false), onToggleSelect: vi.fn() }
		const second = { onAction: vi.fn(), onPointerSelect: vi.fn(() => true), onToggleSelect: vi.fn() }
		const { rerender, container } = render(createElement(ChatsVirtualList, props(el, new Set<string>(), first)), { container: el })

		rerender(createElement(ChatsVirtualList, props(el, new Set<string>(), second)))

		const link = container.querySelectorAll("a")[2]

		if (link === undefined) {
			throw new Error("row not rendered")
		}

		fireEvent.click(link, { ctrlKey: true })

		expect(first.onPointerSelect).not.toHaveBeenCalled()
		expect(second.onPointerSelect).toHaveBeenCalledWith(2, expect.anything(), expect.any(String))
	})
})
