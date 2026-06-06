import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockConfirmedAction, mockGetState } = vi.hoisted(() => ({
	mockConfirmedAction: vi.fn(),
	mockGetState: vi.fn()
}))

vi.mock("@/lib/confirmedAction", () => ({ confirmedAction: mockConfirmedAction }))

vi.mock("@/stores/useApp.store", () => ({
	default: { getState: mockGetState }
}))

import { confirmedChatAction } from "@/features/chats/components/confirmedChatAction"

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE = {
	promptTitle: "Delete chat",
	promptMessage: "Are you sure?",
	promptOkText: "Delete",
	action: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("confirmedChatAction", () => {
	beforeEach(() => {
		mockConfirmedAction.mockReset()
		mockGetState.mockReset()
		BASE.action.mockReset().mockResolvedValue(undefined)
	})

	it("calls confirmedAction with dismiss=undefined when dismissPathnamePrefix is omitted", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())

		confirmedChatAction({ ...BASE })

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: unknown }
		expect(callArgs?.dismiss).toBeUndefined()
	})

	it("passes dismiss=undefined when dismissPathnamePrefix is explicitly undefined", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())

		confirmedChatAction({ ...BASE, dismissPathnamePrefix: undefined })

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: unknown }
		expect(callArgs?.dismiss).toBeUndefined()
	})

	it("passes a dismiss function when dismissPathnamePrefix is provided", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())

		confirmedChatAction({ ...BASE, dismissPathnamePrefix: "/chat/" })

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: unknown }
		expect(typeof callArgs?.dismiss).toBe("function")
	})

	it("dismiss() returns true when the current pathname starts with the prefix", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())
		mockGetState.mockReturnValue({ pathname: "/chat/abc-123" })

		confirmedChatAction({ ...BASE, dismissPathnamePrefix: "/chat/" })

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: () => boolean }
		expect(callArgs?.dismiss()).toBe(true)
	})

	it("dismiss() returns false when the current pathname does not start with the prefix", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())
		mockGetState.mockReturnValue({ pathname: "/drive/root" })

		confirmedChatAction({ ...BASE, dismissPathnamePrefix: "/chat/" })

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: () => boolean }
		expect(callArgs?.dismiss()).toBe(false)
	})

	it("dismiss() returns false for a partial prefix match that is not a startsWith match", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())
		mockGetState.mockReturnValue({ pathname: "/not-chat/123" })

		confirmedChatAction({ ...BASE, dismissPathnamePrefix: "/chat/" })

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: () => boolean }
		expect(callArgs?.dismiss()).toBe(false)
	})

	it("dismiss() returns true when pathname exactly equals the prefix", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())
		mockGetState.mockReturnValue({ pathname: "/chat/" })

		confirmedChatAction({ ...BASE, dismissPathnamePrefix: "/chat/" })

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: () => boolean }
		expect(callArgs?.dismiss()).toBe(true)
	})

	it("forwards all other confirmedAction options unchanged", () => {
		mockConfirmedAction.mockReturnValue(vi.fn())

		const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

		confirmedChatAction({
			promptTitle: "Leave",
			promptMessage: "Leave chat?",
			promptOkText: "Leave",
			promptDestructive: false,
			action,
			dismissPathnamePrefix: "/chat/"
		})

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as {
			promptTitle: string
			promptMessage: string
			promptOkText: string
			promptDestructive: boolean
			action: () => Promise<void>
		}
		expect(callArgs?.promptTitle).toBe("Leave")
		expect(callArgs?.promptMessage).toBe("Leave chat?")
		expect(callArgs?.promptOkText).toBe("Leave")
		expect(callArgs?.promptDestructive).toBe(false)
		expect(callArgs?.action).toBe(action)
	})

	it("returns the thunk produced by confirmedAction", () => {
		const thunk = vi.fn()
		mockConfirmedAction.mockReturnValue(thunk)

		const result = confirmedChatAction({ ...BASE })

		expect(result).toBe(thunk)
	})
})
