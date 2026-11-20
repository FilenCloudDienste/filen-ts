// @vitest-environment jsdom

// "Copy ID" in the conversation menu and the message menu: each copies the uuid through the app's copy helper, which
// owns the clipboard write and the toast.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"
import { testUuid } from "@/tests/support/uuid"
import { mockChat, mockChatMessage, mockChatParticipant } from "@/tests/fixtures/sdk"
import "@/lib/i18n"

const { copyText } = vi.hoisted(() => ({
	copyText: vi.fn<(text: string, successMessage: string) => Promise<boolean>>(() => Promise.resolve(true))
}))

vi.mock("@/lib/copyText", () => ({ copyText }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

const { ChatDropdownMenuContent } = await import("@/features/chats/components/chatMenu")
const { DropdownMenu, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu")
const { useMessageActions } = await import("@/features/chats/components/thread/useMessageActions")

const chat = mockChat({
	uuid: testUuid("c1"),
	name: "Team",
	participants: [mockChatParticipant({ userId: 1n, email: "me@x.io" }), mockChatParticipant({ userId: 2n, email: "bob@x.io" })]
})

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

describe("conversation menu Copy ID", () => {
	it("copies the conversation's uuid", () => {
		render(
			createElement(
				DropdownMenu,
				{ defaultOpen: true },
				createElement(DropdownMenuTrigger, null, "menu"),
				createElement(ChatDropdownMenuContent, {
					chat,
					currentUserId: 2n,
					blocked: EMPTY_BLOCKED_USERS,
					onAction: () => undefined
				})
			)
		)

		fireEvent.click(screen.getByRole("menuitem", { name: "Copy ID" }))

		expect(copyText).toHaveBeenCalledWith(chat.uuid, "Conversation ID copied to clipboard")
	})
})

describe("message menu Copy ID", () => {
	function actionsFor(sendState: "confirmed" | "pending") {
		return renderHook(() =>
			useMessageActions({
				chat,
				message: mockChatMessage({ uuid: testUuid("m1"), chat: chat.uuid, senderId: 2, message: "hello" }),
				currentUserId: 1n,
				sendState,
				hasEmbeds: false,
				onRequestDelete: vi.fn(),
				blocked: EMPTY_BLOCKED_USERS
			})
		).result
	}

	it("copies a sent message's uuid", () => {
		const result = actionsFor("confirmed")
		const copyId = result.current.descriptors.find(descriptor => descriptor.id === "copyId")

		expect(copyId).toBeDefined()

		if (copyId !== undefined) {
			act(() => {
				result.current.runAction(copyId)
			})
		}

		expect(copyText).toHaveBeenCalledWith(testUuid("m1"), "Message ID copied to clipboard")
	})

	it("is not offered on a message still being sent (its id is local)", () => {
		expect(actionsFor("pending").current.descriptors.map(descriptor => descriptor.id)).not.toContain("copyId")
	})
})
