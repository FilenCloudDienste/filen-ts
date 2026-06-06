import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockAlert, mockRunWithLoading, mockAlertsError, mockCanGoBack, mockBack } = vi.hoisted(() => ({
	mockAlert: vi.fn(),
	mockRunWithLoading: vi.fn(),
	mockAlertsError: vi.fn(),
	mockCanGoBack: vi.fn(() => true),
	mockBack: vi.fn()
}))

vi.mock("@/lib/prompts", () => ({ default: { alert: mockAlert } }))
vi.mock("@/lib/alerts", () => ({ default: { error: mockAlertsError } }))
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }))
vi.mock("expo-router", () => ({ router: { canGoBack: mockCanGoBack, back: mockBack } }))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: mockRunWithLoading }))
vi.mock("@filen/utils", () => ({
	run: async (fn: () => Promise<unknown>) => {
		try {
			return { success: true, data: await fn() }
		} catch (error) {
			return { success: false, error }
		}
	}
}))

import { confirmedAction } from "@/lib/confirmedAction"

const PROMPT = { promptTitle: "title", promptMessage: "message", promptOkText: "ok" }

describe("confirmedAction", () => {
	beforeEach(() => {
		mockAlert.mockReset()
		mockAlertsError.mockReset()
		mockCanGoBack.mockReset().mockReturnValue(true)
		mockBack.mockReset()
		mockRunWithLoading.mockReset().mockImplementation(async (fn: () => Promise<void>) => {
			try {
				await fn()

				return { success: true }
			} catch (error) {
				return { success: false, error }
			}
		})
	})

	it("does not run the action when the prompt is cancelled", async () => {
		mockAlert.mockResolvedValue({ cancelled: true })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action })()

		expect(action).not.toHaveBeenCalled()
		expect(mockRunWithLoading).not.toHaveBeenCalled()
		expect(mockBack).not.toHaveBeenCalled()
	})

	it("surfaces an error and does not run the action when the prompt itself fails", async () => {
		mockAlert.mockRejectedValue(new Error("prompt boom"))
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action })()

		expect(mockAlertsError).toHaveBeenCalledTimes(1)
		expect(action).not.toHaveBeenCalled()
		expect(mockBack).not.toHaveBeenCalled()
	})

	it("runs the action and pops back when confirmed, dismiss true and canGoBack", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action, dismiss: () => true })()

		expect(action).toHaveBeenCalledTimes(1)
		expect(mockBack).toHaveBeenCalledTimes(1)
	})

	it("does not pop back when dismiss returns false", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action, dismiss: () => false })()

		expect(action).toHaveBeenCalledTimes(1)
		expect(mockBack).not.toHaveBeenCalled()
	})

	it("does not pop back when no dismiss predicate is provided", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action })()

		expect(action).toHaveBeenCalledTimes(1)
		expect(mockBack).not.toHaveBeenCalled()
	})

	it("does not pop back when dismiss is true but the router cannot go back", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		mockCanGoBack.mockReturnValue(false)
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action, dismiss: () => true })()

		expect(mockBack).not.toHaveBeenCalled()
	})

	it("surfaces an error and does not pop back when the action fails", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockRejectedValue(new Error("action boom"))

		await confirmedAction({ ...PROMPT, action, dismiss: () => true })()

		expect(mockAlertsError).toHaveBeenCalledTimes(1)
		expect(mockBack).not.toHaveBeenCalled()
	})

	it("forwards destructive:true to prompts.alert by default", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action })()

		expect(mockAlert).toHaveBeenCalledTimes(1)
		const callArg = mockAlert.mock.calls[0]?.[0] as Record<string, unknown>
		expect(callArg?.["destructive"]).toBe(true)
	})

	it("forwards destructive:false to prompts.alert when promptDestructive is false", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action, promptDestructive: false })()

		expect(mockAlert).toHaveBeenCalledTimes(1)
		const callArg = mockAlert.mock.calls[0]?.[0] as Record<string, unknown>
		expect(callArg?.["destructive"]).toBe(false)
	})

	it("does not run the action when cancelled with promptDestructive:false", async () => {
		mockAlert.mockResolvedValue({ cancelled: true })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action, promptDestructive: false })()

		expect(action).not.toHaveBeenCalled()
		expect(mockBack).not.toHaveBeenCalled()
		const callArg = mockAlert.mock.calls[0]?.[0] as Record<string, unknown>
		expect(callArg?.["destructive"]).toBe(false)
	})

	it("forwards destructive:true when promptDestructive is explicitly true", async () => {
		mockAlert.mockResolvedValue({ cancelled: false })
		const action = vi.fn().mockResolvedValue(undefined)

		await confirmedAction({ ...PROMPT, action, promptDestructive: true })()

		expect(mockAlert).toHaveBeenCalledTimes(1)
		const callArg = mockAlert.mock.calls[0]?.[0] as Record<string, unknown>
		expect(callArg?.["destructive"]).toBe(true)
	})
})
