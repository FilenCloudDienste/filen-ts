// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import type { ChatMessage } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"

const { blockContactByEmail, toastSuccess, toastError } = vi.hoisted(() => ({
	blockContactByEmail: vi.fn<(identity: unknown) => Promise<{ status: "success" }>>(() => Promise.resolve({ status: "success" })),
	toastSuccess: vi.fn(),
	toastError: vi.fn()
}))

vi.mock("@/features/contacts/lib/actions", () => ({ blockContactByEmail }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))

import { MessageBlockRequestContext, useMessageActions, useMessageBlockConfirm } from "@/features/chats/components/thread/useMessageActions"
import { testUuid } from "@/tests/support/uuid"
import { mockChatMessage, mockUndecryptableChat } from "@/tests/fixtures/sdk"

const chat = mockUndecryptableChat({ uuid: testUuid("c1") })

const message = mockChatMessage({
	uuid: testUuid("m1"),
	chat: testUuid("c1"),
	senderId: 5,
	senderEmail: "peer@x.io",
	senderNickName: "Peer",
	message: "hello",
	sentTimestamp: 100n
})

beforeEach(() => {
	vi.clearAllMocks()
})

describe("block from a message menu", () => {
	it("choosing Block requests the thread's confirm and blocks nothing yet", () => {
		const request = vi.fn<(message: ChatMessage) => void>()

		function wrapper({ children }: { children: ReactNode }) {
			return createElement(MessageBlockRequestContext, { value: request }, children)
		}

		const { result } = renderHook(
			() =>
				useMessageActions({
					chat,
					message,
					currentUserId: 1n,
					sendState: "confirmed",
					hasEmbeds: false,
					onRequestDelete: vi.fn(),
					blocked: EMPTY_BLOCKED_USERS
				}),
			{ wrapper }
		)

		const block = result.current.descriptors.find(d => d.id === "block")

		expect(block?.run).toBe("dialog")

		if (block !== undefined) {
			act(() => {
				result.current.runAction(block)
			})
		}

		expect(request).toHaveBeenCalledWith(message)
		expect(blockContactByEmail).not.toHaveBeenCalled()
	})

	it("cancelling the confirm blocks nothing", () => {
		const { result } = renderHook(() => useMessageBlockConfirm())

		act(() => {
			result.current.request(message)
		})

		expect(result.current.target).toBe(message)

		act(() => {
			result.current.cancel()
		})

		expect(result.current.target).toBeNull()
		expect(blockContactByEmail).not.toHaveBeenCalled()
	})

	it("confirming blocks the message's sender, then closes", async () => {
		const { result } = renderHook(() => useMessageBlockConfirm())

		act(() => {
			result.current.request(message)
		})

		await act(() => result.current.confirm())

		expect(blockContactByEmail).toHaveBeenCalledTimes(1)
		expect(blockContactByEmail).toHaveBeenCalledWith({ email: "peer@x.io", userId: 5n, nickName: "Peer", avatar: undefined })
		expect(result.current.target).toBeNull()
		expect(toastSuccess).toHaveBeenCalledWith("User blocked")
	})
})
