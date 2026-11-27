// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
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
import { mockChat, mockChatMessage } from "@/tests/fixtures/sdk"
import { registerAllActions } from "@/lib/keymap/actions"

// The action bar's tooltips show each action's keys.
registerAllActions()

const chat = mockChat()

const message = mockChatMessage({ senderEmail: "a@example.com", message: "hello", chat: chat.uuid })

const descriptors = messageMenuActions(message, 1n, "confirmed")

function renderRow(overrides: { runStart?: boolean; currentUserId?: bigint; replying?: boolean } = {}) {
	useMessageActions.mockReturnValue({ descriptors, runAction })

	return render(
		createElement(MessageRow, {
			chat,
			message,
			runStart: overrides.runStart ?? true,
			currentUserId: overrides.currentUserId ?? 1n,
			ownAvatarUrl: undefined,
			blocked: deriveBlockedUsers([]),
			active: false,
			actionsRef: null,
			replying: overrides.replying ?? false
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

describe("MessageActionBar tooltips", () => {
	it("creates no tooltip until the pointer reaches the bar, then names each button with its key", async () => {
		renderRow()

		const toolbar = screen.getByRole("toolbar", { name: "Message actions" })

		expect(toolbar.querySelectorAll("[data-slot='tooltip-trigger']")).toHaveLength(0)

		fireEvent.pointerEnter(toolbar, { pointerType: "mouse" })

		const triggers = toolbar.querySelectorAll("[data-slot='tooltip-trigger']")

		// Reply, Copy, Edit and the ⋯ overflow.
		expect(triggers).toHaveLength(4)

		const replyTrigger = within(toolbar).getByRole("button", { name: "Reply" })

		fireEvent.mouseEnter(replyTrigger)
		fireEvent.mouseMove(replyTrigger)

		const popup = await waitFor(() => {
			const found = document.querySelector("[data-slot='tooltip-content']")

			if (found === null) {
				throw new Error("no tooltip")
			}

			return found
		})

		expect(popup.textContent).toContain("Reply")
		expect(popup.querySelector("[data-slot='kbd']")?.textContent).toBe("R")

		fireEvent.pointerLeave(toolbar)

		expect(toolbar.querySelectorAll("[data-slot='tooltip-trigger']")).toHaveLength(0)
	})

	it("never creates them for a touch or pen, so a tap never remounts the button it presses", () => {
		renderRow()

		const toolbar = screen.getByRole("toolbar", { name: "Message actions" })
		const reply = within(toolbar).getByRole("button", { name: "Reply" })

		fireEvent.pointerEnter(toolbar, { pointerType: "touch" })
		fireEvent.pointerEnter(toolbar, { pointerType: "pen" })

		expect(toolbar.querySelectorAll("[data-slot='tooltip-trigger']")).toHaveLength(0)
		expect(within(toolbar).getByRole("button", { name: "Reply" })).toBe(reply)
	})

	it("drops them when the ⋯ menu closes with the pointer no longer over the bar", async () => {
		renderRow()

		const toolbar = screen.getByRole("toolbar", { name: "Message actions" })

		fireEvent.pointerEnter(toolbar, { pointerType: "mouse" })
		fireEvent.click(within(toolbar).getByRole("button", { name: "More actions" }))
		await screen.findByRole("menu")
		// Into the menu: the bar holds its tooltips while the menu is open.
		fireEvent.pointerLeave(toolbar)
		expect(toolbar.querySelectorAll("[data-slot='tooltip-trigger']")).toHaveLength(4)

		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })

		await waitFor(() => {
			expect(toolbar.querySelectorAll("[data-slot='tooltip-trigger']")).toHaveLength(0)
		})
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

	it("left-aligns every row, own rows untinted, with one hover highlight", () => {
		renderRow()

		const own = screen.getByText("hello").closest(".group")

		expect(own?.className).not.toContain("chat-own")
		expect(own?.classList).not.toContain("items-end")
		expect(own?.classList).toContain("hover:bg-muted")
		expect(own?.classList).not.toContain("bg-muted")
		cleanup()

		renderRow({ currentUserId: 2n })

		const other = screen.getByText("hello").closest(".group")

		expect(other?.className).toBe(own?.className)
	})

	it("wears the hover highlight while the composer replies to it", () => {
		renderRow({ replying: true })

		expect(screen.getByText("hello").closest(".group")?.classList).toContain("bg-muted")
	})

	// jsdom applies no CSS: this pins that the highlight follows Base UI's open-trigger attribute, which the row carries
	// while its context menu is open, and the action bar's ⋯ trigger while its menu is.
	it("holds the hover highlight while its context menu or ⋯ menu is open", async () => {
		renderRow()

		const row = screen.getByText("hello").closest(".group")

		if (row === null) {
			throw new Error("row not rendered")
		}

		expect(row.classList).toContain("data-popup-open:bg-muted")
		expect(row.classList).toContain("has-[[data-popup-open]]:bg-muted")
		expect(row.hasAttribute("data-popup-open")).toBe(false)

		fireEvent.contextMenu(row)
		await screen.findByRole("menuitem", { name: "Copy" })

		expect(row.hasAttribute("data-popup-open")).toBe(true)
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})

		const more = within(screen.getByRole("toolbar", { name: "Message actions" })).getByRole("button", { name: "More actions" })

		fireEvent.click(more)
		await screen.findByRole("menuitem", { name: "Copy" })

		expect(row.querySelector("[data-popup-open]")).toBe(more)
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

	it("shows only the clock on a run's first line, the day divider above naming the day", () => {
		renderRow()

		const time = screen.getByText(formatClockTime(message.sentTimestamp)).closest("time")
		const full = time?.getAttribute("title") ?? ""

		expect(full).toContain(formatClockTime(message.sentTimestamp))
		expect(full.length).toBeGreaterThan(formatClockTime(message.sentTimestamp).length)
		expect(screen.getByText(full).className).toContain("sr-only")
	})

	it("draws no bubble", () => {
		const { container } = renderRow()

		expect(container.querySelector(".rounded-\\[18px\\]")).toBeNull()
		expect(container.querySelector("svg.fill-current")).toBeNull()
	})
})

// The action bar shows on hover and focus, which a touch never gives: a long-press on the message opens its actions.
describe("MessageRow touch long-press", () => {
	function messageBody(container: HTMLElement): HTMLElement {
		const body = container.querySelector("[data-message-focus] .select-text")

		if (!(body instanceof HTMLElement)) {
			throw new Error("no message body")
		}

		return body
	}

	it("opens the message's actions after a held touch, and swallows the click its lift produces", async () => {
		vi.useFakeTimers()

		try {
			const { container } = renderRow()
			const body = messageBody(container)

			fireEvent.pointerDown(body, { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 })
			vi.advanceTimersByTime(500)
			vi.useRealTimers()

			await waitFor(() => {
				expect(screen.getByRole("menuitem", { name: "Reply" })).toBeTruthy()
			})

			fireEvent.pointerUp(body, { pointerType: "touch", pointerId: 1 })

			expect(fireEvent.click(body)).toBe(false)
			expect(screen.getByRole("menuitem", { name: "Reply" })).toBeTruthy()
		} finally {
			vi.useRealTimers()
		}
	})

	it("opens nothing for a touch that moves (a scroll) or lifts early, nor for a mouse press", () => {
		vi.useFakeTimers()

		try {
			const { container } = renderRow()
			const body = messageBody(container)

			fireEvent.pointerDown(body, { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 })
			fireEvent.pointerMove(body, { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 40 })
			vi.advanceTimersByTime(600)

			fireEvent.pointerDown(body, { pointerType: "touch", isPrimary: true, pointerId: 2, clientX: 10, clientY: 10 })
			fireEvent.pointerUp(body, { pointerType: "touch", pointerId: 2 })
			vi.advanceTimersByTime(600)

			fireEvent.pointerDown(body, { pointerType: "mouse", isPrimary: true, pointerId: 3, clientX: 10, clientY: 10 })
			vi.advanceTimersByTime(600)

			expect(screen.queryByRole("menuitem")).toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})
})
