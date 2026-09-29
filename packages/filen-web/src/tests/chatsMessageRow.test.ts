// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
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

function renderRow(showHeader = true) {
	useMessageActions.mockReturnValue({ descriptors, runAction })

	return render(createElement(MessageRow, { chat, message, showHeader, currentUserId: 1n, blocked: deriveBlockedUsers([]) }))
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

// jsdom has no layout, so this pins the classes that keep it out of the row's height; the heights
// themselves (a one-line continuation row at 24px) were measured in Chromium, Firefox and WebKit.
describe("MessageRow continuation timestamp", () => {
	it("takes no layout height and never wraps inside the avatar gutter", () => {
		renderRow(false)

		const stamp = screen.getByText(formatClockTime(message.sentTimestamp))

		expect(stamp.classList).toContain("absolute")
		expect(stamp.classList).toContain("whitespace-nowrap")
		expect(stamp.parentElement?.classList).toContain("relative")
	})

	it("sizes the body block's own lines to the body text", () => {
		renderRow(false)

		expect(screen.getByText("hello").closest(".min-w-0")?.classList).toContain("text-sm")
	})
})
