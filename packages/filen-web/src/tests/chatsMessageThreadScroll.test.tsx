// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"

// The thread's scroll bookkeeping on its column-reverse scroller (scrollTop 0 at the bottom, negative going
// up): following arrivals while at the bottom, badging them while scrolled up, paging older history near
// the top, retrying a failed older page, and keeping an in-flight older page from one chat out of the next
// chat. The scroller's keyboard contract: it is a focusable, named region, Home and End jump, and neither
// the focused row nor the pill's focus is dropped to the body. Also the unread divider's
// click-to-mark-read, which must report a failure.
// jsdom has no layout (and no Element.scrollTo, so the virtualizer's own writes are inert here): the scroll
// container's geometry is faked and every collaborator is stubbed.

const { messagesByChat, loadOlderChatMessages, markChatRead, toastError } = vi.hoisted(() => ({
	messagesByChat: new Map<string, ChatMessage[]>(),
	loadOlderChatMessages: vi.fn<(chat: Chat, before: bigint) => Promise<ChatMessage[]>>(),
	markChatRead: vi.fn<(chat: Chat) => Promise<{ status: "success" } | { status: "error"; dto: unknown }>>(),
	toastError: vi.fn()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/chats/queries/chatMessages", () => ({
	useChatMessages: (chatUuid: string) => ({ data: messagesByChat.get(chatUuid), isPending: false, isError: false }),
	loadOlderChatMessages
}))
vi.mock("@/queries/account", () => ({
	useAccountQuery: () => ({ data: { id: 7n, email: "me@filen.io", avatarUrl: undefined, nickName: "Me" } })
}))
vi.mock("@/features/contacts/hooks/useBlockedUsers", () => ({ useBlockedUsers: () => EMPTY_BLOCKED_USERS }))
vi.mock("@/features/chats/components/thread/composer", () => ({
	Composer: ({ onSent }: { onSent: () => void }) => createElement("button", { type: "button", onClick: onSent }, "Send")
}))
vi.mock("@/features/chats/components/thread/typingIndicator", () => ({ TypingIndicator: () => null }))
vi.mock("@/features/chats/components/thread/messageRow", () => ({
	MessageRow: ({ message }: { message: ChatMessage }) =>
		createElement("button", { type: "button", "data-testid": "message" }, message.message)
}))
vi.mock("@/features/chats/components/chatMenu", () => ({ ChatDropdownMenuContent: () => null }))
vi.mock("@/features/chats/hooks/useChatDialogHost", () => ({
	useChatDialogHost: () => ({ openChatDialog: vi.fn(), renderActiveDialog: () => null })
}))
vi.mock("@/features/chats/lib/actions", () => ({ markChatRead }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: () => "Could not mark as read" }))

import "@/lib/i18n"
import { MessageThread } from "@/features/chats/components/thread/messageThread"
import { RUN_CONTINUATION_ROW_ESTIMATE } from "@/features/chats/components/thread/thread.logic"
import { testUuid } from "@/tests/support/uuid"

const CLIENT_HEIGHT = 300
// A run's bubbles measure at their estimate, as they do in a browser.
const ROW_HEIGHT = RUN_CONTINUATION_ROW_ESTIMATE
const geometry = { scrollHeight: 1000 }

function scrollContainer(): HTMLElement {
	const el = document.querySelector<HTMLElement>(".overflow-y-auto")

	if (el === null) {
		throw new Error("scroll container not rendered")
	}

	return el
}

// The virtualizer sizes its viewport off offsetHeight; without one it renders no rows at all. Rows measure
// ROW_HEIGHT each, so a long thread really virtualizes.
const FAKED_GEOMETRY = {
	scrollHeight: () => geometry.scrollHeight,
	clientHeight: () => CLIENT_HEIGHT,
	offsetHeight: () => CLIENT_HEIGHT
} as const
const ROW_GEOMETRY: Partial<Record<keyof typeof FAKED_GEOMETRY, number>> = { offsetHeight: ROW_HEIGHT }
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
	for (const [name, value] of Object.entries(FAKED_GEOMETRY)) {
		originalDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
		Object.defineProperty(HTMLElement.prototype, name, {
			configurable: true,
			get(this: HTMLElement) {
				if (this.classList.contains("overflow-y-auto")) {
					return value()
				}

				return this.hasAttribute("data-index") ? (ROW_GEOMETRY[name as keyof typeof FAKED_GEOMETRY] ?? 0) : 0
			}
		})
	}
})

afterAll(() => {
	for (const [name, descriptor] of originalDescriptors) {
		if (descriptor === undefined) {
			Reflect.deleteProperty(HTMLElement.prototype, name)
		} else {
			Object.defineProperty(HTMLElement.prototype, name, descriptor)
		}
	}
})

function chat(label: string): Chat {
	return { uuid: testUuid(label), ownerId: 1n, participants: [], muted: false, created: 0n, lastFocus: 10_000n }
}

function message(chatLabel: string, label: string, sentTimestamp: bigint, senderId = 9): ChatMessage {
	return {
		uuid: testUuid(label),
		chat: testUuid(chatLabel),
		senderId,
		senderEmail: "peer@filen.io",
		senderNickName: "Peer",
		message: label,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp
	}
}

beforeEach(() => {
	messagesByChat.clear()
	loadOlderChatMessages.mockReset()
	geometry.scrollHeight = 1000
})

// A new chat object per arrival, as socketHandlers.ts's lastMessage patch produces.
function arrive(open: Chat, next: ChatMessage, rerender: (ui: ReturnType<typeof createElement>) => void): void {
	messagesByChat.set(open.uuid, [...(messagesByChat.get(open.uuid) ?? []), next])
	rerender(createElement(MessageThread, { chat: { ...open } }))
}

function scrollTo(el: HTMLElement, scrollTop: number): void {
	el.scrollTop = scrollTop
	fireEvent.scroll(el)
}

describe("MessageThread — bottom-anchored layout", () => {
	it("opens at the newest message on the scroller's bottom origin, rows in chronological DOM order", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		expect(el.classList.contains("flex-col-reverse")).toBe(true)
		expect(el.scrollTop).toBe(0)
		expect(screen.getAllByTestId("message").map(row => row.textContent)).toEqual(["m1", "m2"])
	})
})

describe("MessageThread — following the tail", () => {
	it("leaves the view at the bottom when a message arrives there", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		const { rerender } = render(createElement(MessageThread, { chat: a }))

		arrive(a, message("a", "m3", 300n), rerender)

		expect(scrollContainer().scrollTop).toBe(0)
		expect(screen.queryByText("1 new")).toBeNull()
	})

	it("snaps a reader sitting just above the bottom onto the new message", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		const { rerender } = render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		scrollTo(el, -40)
		arrive(a, message("a", "m3", 300n), rerender)

		expect(el.scrollTop).toBe(0)
		expect(screen.queryByText("1 new")).toBeNull()
	})

	it("stays put and badges the arrival when the reader has scrolled up", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		const { rerender } = render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		scrollTo(el, -400)
		arrive(a, message("a", "m3", 300n), rerender)

		expect(el.scrollTop).toBe(-400)
		expect(screen.getByText("1 new")).toBeTruthy()
	})

	it("does not pull a reader who scrolls back near the bottom onto it", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		scrollTo(el, -400)
		scrollTo(el, -40)

		expect(el.scrollTop).toBe(-40)
	})

	it("jumps back to the newest message on an own send, without badging it", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		const { rerender } = render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		scrollTo(el, -400)
		fireEvent.click(screen.getByText("Send"))
		arrive(a, message("a", "mine", 300n, 7), rerender)

		expect(el.scrollTop).toBe(0)
		expect(screen.queryByText("1 new")).toBeNull()
	})

	it("returns to the bottom from the new-messages pill", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		const { rerender } = render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		scrollTo(el, -400)
		arrive(a, message("a", "m3", 300n), rerender)
		fireEvent.click(screen.getByText("1 new"))

		expect(el.scrollTop).toBe(0)
	})
})

// scrollHeight 1000, clientHeight 300: the top edge sits at scrollTop -700.
describe("MessageThread — loading older pages", () => {
	it("pages in older history near the top only", async () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])
		loadOlderChatMessages.mockResolvedValue([])

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		await act(async () => {
			scrollTo(el, -500)
			await Promise.resolve()
		})

		expect(loadOlderChatMessages).not.toHaveBeenCalled()

		await act(async () => {
			scrollTo(el, -600)
			await Promise.resolve()
		})

		expect(loadOlderChatMessages).toHaveBeenCalledTimes(1)
		expect(loadOlderChatMessages.mock.calls[0]?.[1]).toBe(100n)
	})

	it("shows the spinner first in the DOM, where it sits on screen", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])
		loadOlderChatMessages.mockReturnValueOnce(new Promise<ChatMessage[]>(() => undefined))

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		act(() => {
			scrollTo(el, -700)
		})

		expect(el.firstElementChild?.contains(screen.getByLabelText("Loading earlier messages…"))).toBe(true)
	})

	it("retries on the next scroll after a failed page instead of turning paging off", async () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])
		loadOlderChatMessages.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([])

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		await act(async () => {
			scrollTo(el, -700)
			await Promise.resolve()
		})

		await act(async () => {
			fireEvent.scroll(el)
			await Promise.resolve()
		})

		expect(loadOlderChatMessages).toHaveBeenCalledTimes(2)
	})

	it("does not let an older page still in flight from the previous chat disable the next chat's paging", async () => {
		const a = chat("a")
		const b = chat("b")
		messagesByChat.set(a.uuid, [message("a", "a1", 100n), message("a", "a2", 200n)])
		messagesByChat.set(b.uuid, [message("b", "b1", 100n), message("b", "b2", 200n), message("b", "b3", 300n)])

		let resolveA: (page: ChatMessage[]) => void = () => undefined

		loadOlderChatMessages
			.mockImplementationOnce(
				() =>
					new Promise<ChatMessage[]>(resolve => {
						resolveA = resolve
					})
			)
			.mockResolvedValueOnce([])

		const { rerender } = render(createElement(MessageThread, { chat: a }))

		act(() => {
			scrollTo(scrollContainer(), -700)
		})

		expect(screen.getByLabelText("Loading earlier messages…")).toBeTruthy()

		rerender(createElement(MessageThread, { chat: b }))

		// B opens at its newest message, not at A's scroll position, and without A's spinner.
		expect(scrollContainer().scrollTop).toBe(0)
		expect(screen.queryByLabelText("Loading earlier messages…")).toBeNull()

		// A's history is exhausted: that must not switch B's paging off.
		await act(async () => {
			resolveA([])
			await Promise.resolve()
		})

		await act(async () => {
			scrollTo(scrollContainer(), -700)
			await Promise.resolve()
		})

		expect(loadOlderChatMessages).toHaveBeenCalledTimes(2)
		expect(loadOlderChatMessages.mock.calls[1]?.[0].uuid).toBe(b.uuid)
	})
})

describe("MessageThread — unread divider", () => {
	it("reports a failed mark-as-read instead of silently leaving the divider", async () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 20_000n)])
		markChatRead.mockResolvedValueOnce({ status: "error", dto: {} })

		render(createElement(MessageThread, { chat: a }))

		await act(async () => {
			fireEvent.click(screen.getByText("New"))
			await Promise.resolve()
		})

		expect(markChatRead).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Could not mark as read")
	})
})

describe("MessageThread — keyboard", () => {
	it("makes the scroller a focusable region named by the conversation title", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n)])

		render(createElement(MessageThread, { chat: a }))

		const title = screen.getByRole("heading", { level: 1 }).textContent
		const region = screen.getByRole("region", { name: title })

		expect(region).toBe(scrollContainer())
		expect(region.tabIndex).toBe(0)
	})

	it("jumps to the oldest loaded message on Home and back to the newest on End", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])
		loadOlderChatMessages.mockReturnValue(new Promise<ChatMessage[]>(() => undefined))

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		expect(fireEvent.keyDown(el, { key: "Home" })).toBe(false)
		expect(el.scrollTop).toBe(-geometry.scrollHeight)

		expect(fireEvent.keyDown(el, { key: "End" })).toBe(false)
		expect(el.scrollTop).toBe(0)
	})

	it("leaves modified Home and End to the browser", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n)])

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		expect(fireEvent.keyDown(el, { key: "Home", shiftKey: true })).toBe(true)
		expect(fireEvent.keyDown(el, { key: "Home", ctrlKey: true })).toBe(true)
		expect(el.scrollTop).toBe(0)
	})

	it("keeps the row holding focus mounted when it scrolls far out of view", () => {
		const a = chat("a")
		const history = Array.from({ length: 80 }, (_, i) => message("a", `m${String(i)}`, BigInt(100 + i)))
		messagesByChat.set(a.uuid, history)
		geometry.scrollHeight = history.length * ROW_HEIGHT
		loadOlderChatMessages.mockReturnValue(new Promise<ChatMessage[]>(() => undefined))

		render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()
		const focused = screen.getByText("m78")

		act(() => {
			focused.focus()
		})

		act(() => {
			scrollTo(el, -(geometry.scrollHeight - CLIENT_HEIGHT))
		})

		// Its neighbours are gone, so the virtualizer really did move away from it.
		expect(screen.getByText("m0")).toBeTruthy()
		expect(screen.queryByText("m77")).toBeNull()
		expect(focused.isConnected).toBe(true)
		expect(document.activeElement).toBe(focused)
	})

	it("hands the pill's focus to the thread instead of dropping it when the pill goes away", () => {
		const a = chat("a")
		messagesByChat.set(a.uuid, [message("a", "m1", 100n), message("a", "m2", 200n)])

		const { rerender } = render(createElement(MessageThread, { chat: a }))
		const el = scrollContainer()

		scrollTo(el, -400)
		arrive(a, message("a", "m3", 300n), rerender)

		const pill = screen.getByText("1 new")

		act(() => {
			pill.focus()
		})
		fireEvent.click(pill)

		expect(el.scrollTop).toBe(0)
		expect(document.activeElement).toBe(el)
	})
})
