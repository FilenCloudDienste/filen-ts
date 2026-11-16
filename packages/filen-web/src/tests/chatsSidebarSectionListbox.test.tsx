// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { createElement, useState } from "react"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"
import { buildChatList, type ChatSection } from "@/features/chats/components/chatsSidebar.logic"
import { testUuid } from "@/tests/support/uuid"

// A section header controls its listbox only while that listbox exists, and a section with no rows to show renders
// none: an empty listbox is announced as a list of nothing.

vi.mock("@/features/chats/components/chatRow", () => ({
	ChatRow: ({ chat }: { chat: Chat }) => createElement("div", { role: "option", "aria-selected": false }, chat.uuid)
}))

const { ChatsVirtualList } = await import("@/features/chats/components/chatsSidebar")

afterEach(() => {
	cleanup()
})

function participant(userId: bigint): ChatParticipant {
	return {
		userId,
		email: `${String(userId)}@example.com`,
		nickName: undefined,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n
	}
}

function chat(label: string, userIds: bigint[]): Chat {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		key: "chat-key",
		participants: userIds.map(participant),
		muted: false,
		created: 0n,
		lastFocus: undefined,
		lastMessage: undefined,
		name: label
	} as unknown as Chat
}

const dm = chat("dm", [1n, 2n])
const group = chat("group", [1n, 2n, 3n])

function List({ collapsed }: { collapsed: Readonly<Record<ChatSection, boolean>> }) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const list = buildChatList([dm, group], collapsed, false)

	return createElement(
		"div",
		{
			ref: (element: HTMLDivElement | null) => {
				// jsdom lays nothing out, and the virtualizer renders no rows into a viewport of no size.
				if (element !== null) {
					Object.defineProperty(element, "clientHeight", { configurable: true, value: 600 })
					Object.defineProperty(element, "clientWidth", { configurable: true, value: 300 })
				}

				setScrollElement(element)
			}
		},
		createElement(ChatsVirtualList, {
			items: list.items,
			headerIndexes: list.headerIndexes,
			searching: false,
			scrollElement,
			fallback: null,
			label: "Conversations",
			sectionLabels: { direct: "Direct messages", groups: "Groups" },
			onToggleSection: () => undefined,
			selectedUuid: "",
			liveSelectedUuids: new Set<string>(),
			currentUserId: 1n,
			blocked: EMPTY_BLOCKED_USERS,
			onAction: () => undefined,
			onPointerSelect: () => false,
			onToggleSelect: () => undefined
		})
	)
}

describe("chat sections' listboxes", () => {
	it("renders no listbox for a collapsed section, and its header controls nothing", () => {
		const { container } = render(createElement(List, { collapsed: { direct: true, groups: false } }))
		const headers = [...container.querySelectorAll("button[aria-expanded]")]
		const listboxes = [...container.querySelectorAll('[role="listbox"]')]

		expect(headers.map(header => header.getAttribute("aria-expanded"))).toEqual(["false", "true"])
		expect(listboxes).toHaveLength(1)
		expect(headers[0]?.hasAttribute("aria-controls")).toBe(false)
		expect(headers[1]?.getAttribute("aria-controls")).toBe(listboxes[0]?.id)
		expect(listboxes[0]?.querySelectorAll('[role="option"]')).toHaveLength(1)
	})

	it("points every header at a listbox that exists and has options", () => {
		const { container } = render(createElement(List, { collapsed: { direct: false, groups: false } }))
		const headers = container.querySelectorAll("button[aria-expanded]")

		expect(headers).toHaveLength(2)

		for (const header of headers) {
			const listbox = document.getElementById(header.getAttribute("aria-controls") ?? "")

			expect(listbox?.getAttribute("role")).toBe("listbox")
			expect(listbox?.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
		}
	})
})
