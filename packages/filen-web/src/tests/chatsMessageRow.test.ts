// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { deriveBlockedUsers } from "@filen/shared"
import type { MessageActionDescriptor } from "@/features/chats/components/thread/messageMenu.logic"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest; the hook itself is
// replaced so the test can count its calls and observe which runAction each surface dispatches through.
const { useMessageActions, runAction } = vi.hoisted(() => ({
	useMessageActions: vi.fn(),
	runAction: vi.fn<(descriptor: MessageActionDescriptor) => void>()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/chats/components/thread/useMessageActions", () => ({ useMessageActions }))
vi.mock("@/features/chats/components/thread/messageEmbeds", () => ({ MessageEmbeds: () => null }))

import "@/lib/i18n"
import { messageMenuActions } from "@/features/chats/components/thread/messageMenu.logic"
import { MessageRow } from "@/features/chats/components/thread/messageRow"
import { formatClockTime } from "@/features/chats/lib/time"
import { testUuid } from "@/tests/support/uuid"

const chat: Chat = {
	uuid: testUuid("chat"),
	ownerId: 1n,
	key: "chat-key",
	participants: [],
	muted: false,
	created: 0n,
	lastFocus: 0n
}

const message: ChatMessage = {
	uuid: testUuid("msg"),
	senderId: 1,
	senderEmail: "a@example.com",
	senderNickName: undefined,
	message: "hello",
	chat: chat.uuid,
	embedDisabled: false,
	edited: false,
	editedTimestamp: 0n,
	sentTimestamp: 0n
}

const descriptors = messageMenuActions(message, 1n, "confirmed")

function renderRow(overrides: { runStart?: boolean; runEnd?: boolean; group?: boolean; currentUserId?: bigint } = {}) {
	useMessageActions.mockReturnValue({ descriptors, runAction })

	return render(
		createElement(MessageRow, {
			chat,
			message,
			runStart: overrides.runStart ?? true,
			runEnd: overrides.runEnd ?? true,
			group: overrides.group ?? false,
			currentUserId: overrides.currentUserId ?? 1n,
			blocked: deriveBlockedUsers([])
		})
	)
}

function dispatched(): MessageActionDescriptor["id"][] {
	return runAction.mock.calls.map(([descriptor]) => descriptor.id)
}

describe("MessageRow action model", () => {
	// The hover bar, its overflow and the right-click menu all render with every menu closed, so a hook
	// call in each would triple the per-row online and composer-store subscriptions.
	it("runs useMessageActions once per row render, with the row's own inputs", () => {
		renderRow()

		expect(useMessageActions).toHaveBeenCalledTimes(1)
		expect(useMessageActions.mock.calls[0]?.[0]).toMatchObject({
			chat,
			message,
			currentUserId: 1n,
			sendState: "confirmed",
			hasEmbeds: false
		})
	})

	it("dispatches the hover bar's inline buttons through that one handle", () => {
		renderRow()

		const toolbar = screen.getByRole("toolbar", { name: "Message actions" })

		fireEvent.click(within(toolbar).getByRole("button", { name: "Reply" }))

		expect(dispatched()).toEqual(["reply"])
	})

	it("dispatches the right-click menu through that one handle", async () => {
		const { container } = renderRow()
		const row = container.querySelector(".group")

		if (row === null) {
			throw new Error("row not rendered")
		}

		fireEvent.contextMenu(row)
		fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }))

		expect(dispatched()).toEqual(["copy"])
	})
})

// jsdom has no layout, so this pins the classes that keep the row's height at its estimate; the heights
// themselves were measured in Chromium, Firefox and WebKit (thread.logic.ts).
describe("MessageRow bubble layout", () => {
	it("keeps the hover time and action bar out of the row's height, beside the bubble's inner side", () => {
		renderRow({ runEnd: false })

		const stamp = screen.getByText(formatClockTime(message.sentTimestamp))
		const aside = stamp.parentElement

		expect(stamp.classList).toContain("whitespace-nowrap")
		expect(aside?.classList).toContain("absolute")
		expect(aside?.classList).toContain("right-full")
		expect(aside?.contains(screen.getByRole("toolbar", { name: "Message actions" }))).toBe(true)
	})

	it("puts own messages on the right in the brand bubble and others on the left", () => {
		renderRow()

		const own = screen.getByText("hello").closest(".rounded-\\[18px\\]")

		expect(own?.classList).toContain("bg-chat-own")
		expect(screen.getByText("hello").closest(".group")?.classList).toContain("items-end")
		cleanup()

		renderRow({ currentUserId: 2n })

		expect(screen.getByText("hello").closest(".rounded-\\[18px\\]")?.classList).toContain("bg-chat-other")
		expect(screen.getByText("hello").closest(".group")?.classList).toContain("items-start")
	})

	it("sizes the bubble's lines to the body text", () => {
		renderRow()

		expect(screen.getByText("hello").closest(".rounded-\\[18px\\]")?.classList).toContain("text-sm")
	})

	it("draws the tail only on a run's newest bubble", () => {
		const { container, unmount } = renderRow({ runEnd: false })

		expect(container.querySelector("svg.fill-current")).toBeNull()
		unmount()

		expect(renderRow().container.querySelector("svg.fill-current")).not.toBeNull()
	})

	it("names and pictures someone else's run in a group chat, never in a 1:1 or on own messages", () => {
		renderRow({ currentUserId: 2n })
		expect(screen.queryByText("a@example.com")).toBeNull()
		cleanup()

		renderRow({ currentUserId: 2n, group: true })
		expect(screen.getByText("a@example.com")).toBeTruthy()
		expect(screen.getByText("A")).toBeTruthy()
		cleanup()

		renderRow({ group: true })
		expect(screen.queryByText("a@example.com")).toBeNull()
	})
})
