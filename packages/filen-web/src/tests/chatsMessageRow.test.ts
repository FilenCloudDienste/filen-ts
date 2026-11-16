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

function renderRow(overrides: { runStart?: boolean; currentUserId?: bigint } = {}) {
	useMessageActions.mockReturnValue({ descriptors, runAction })

	return render(
		createElement(MessageRow, {
			chat,
			message,
			runStart: overrides.runStart ?? true,
			currentUserId: overrides.currentUserId ?? 1n,
			blocked: deriveBlockedUsers([]),
			active: false,
			actionsRef: null
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

// jsdom has no layout, so this pins the classes that keep the row's height at its estimate (thread.logic.ts).
describe("MessageRow layout", () => {
	it("keeps the action bar out of the row's height, over its top-right corner", () => {
		renderRow()

		const bar = screen.getByRole("toolbar", { name: "Message actions" }).parentElement

		expect(bar?.classList).toContain("absolute")
		expect(bar?.classList).toContain("right-4")
		expect(bar?.classList).toContain("pointer-events-none")
	})

	it("shows a run's later lines with their time in the gutter, revealed on hover", () => {
		renderRow({ runStart: false })

		const stamp = screen.getByText(formatClockTime(message.sentTimestamp))

		expect(stamp.classList).toContain("whitespace-nowrap")
		expect(stamp.classList).toContain("opacity-0")
		expect(stamp.classList).toContain("group-hover:opacity-100")
		expect(screen.queryByText("You")).toBeNull()
	})

	it("left-aligns every row, tinting own rows only", () => {
		renderRow()

		const own = screen.getByText("hello").closest(".group")

		expect(own?.classList).toContain("bg-chat-own/6")
		expect(own?.classList).not.toContain("items-end")
		cleanup()

		renderRow({ currentUserId: 2n })

		const other = screen.getByText("hello").closest(".group")

		expect(other?.className).not.toContain("bg-chat-own")
		expect(other?.classList).toContain("hover:bg-muted")
	})

	it("caps the text column's measure while the row spans the pane", () => {
		renderRow()

		expect(screen.getByText("hello").closest(".max-w-\\[760px\\]")).not.toBeNull()
		expect(screen.getByText("hello").closest(".group")?.className).not.toContain("max-w-")
	})

	it("opens every run with the avatar and name, in a 1:1 too, naming own runs You", () => {
		renderRow({ currentUserId: 2n })
		expect(screen.getByText("a@example.com")).toBeTruthy()
		expect(screen.getByText("A")).toBeTruthy()
		cleanup()

		renderRow()
		expect(screen.getByText("You")).toBeTruthy()
		expect(screen.queryByText("a@example.com")).toBeNull()
	})

	it("draws no bubble", () => {
		const { container } = renderRow()

		expect(container.querySelector(".rounded-\\[18px\\]")).toBeNull()
		expect(container.querySelector("svg.fill-current")).toBeNull()
	})
})
