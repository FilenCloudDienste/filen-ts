import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockShowNotification, mockErrorToMessage } = vi.hoisted(() => ({
	mockShowNotification: vi.fn(),
	mockErrorToMessage: vi.fn()
}))

// ---------- boundary mocks ----------

vi.mock("react-native-notifier", () => ({
	Notifier: {
		showNotification: mockShowNotification
	},
	NotifierComponents: {
		Alert: "MockAlert"
	}
}))

vi.mock("burnt", () => ({
	default: {
		toast: vi.fn()
	}
}))

vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock("@/components/ui/view", () => ({
	default: () => null
}))

vi.mock("react", async () => {
	const actual = await vi.importActual<typeof import("react")>("react")
	return {
		...actual,
		memo: (c: unknown) => c
	}
})

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))

// The message precedence itself is covered in sdkErrorHumanReadable.test.ts.
vi.mock("@/lib/sdkErrors", () => ({
	errorToMessage: mockErrorToMessage
}))

import { alerts } from "@/lib/alerts"

beforeEach(() => {
	mockShowNotification.mockClear()
	mockErrorToMessage.mockReset()
	mockErrorToMessage.mockImplementation((message: unknown) => String(message))
})

// ---------------------------------------------------------------------------
// Alerts.error
// ---------------------------------------------------------------------------

describe("Alerts.error", () => {
	it("shows errorToMessage's string for the caught value, with no fallback", () => {
		mockErrorToMessage.mockReturnValue("human readable message")

		const fakeError = new Error("raw")
		alerts.error(fakeError)

		expect(mockErrorToMessage).toHaveBeenCalledWith(fakeError)
		expect(mockShowNotification).toHaveBeenCalledTimes(1)
		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { description: string }
		expect(callArgs.description).toBe("human readable message")
	})

	it("calls Notifier.showNotification exactly once per error() call", () => {
		alerts.error("one")
		alerts.error("two")
		expect(mockShowNotification).toHaveBeenCalledTimes(2)
	})

	it("sets the title to the i18n 'error' key", () => {
		alerts.error("x")

		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { title: string }
		expect(callArgs.title).toBe("error")
	})
})
