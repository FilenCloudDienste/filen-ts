import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockShowNotification, mockUnwrapSdkError, mockUnwrappedSdkErrorToHumanReadable } = vi.hoisted(() => ({
	mockShowNotification: vi.fn(),
	mockUnwrapSdkError: vi.fn(),
	mockUnwrappedSdkErrorToHumanReadable: vi.fn()
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

// React / RN surface consumed by the NotifierErrorContainer component
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

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

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

// Mock the utils boundary so we control what unwrapSdkError returns
vi.mock("@/lib/utils", () => ({
	unwrapSdkError: mockUnwrapSdkError,
	unwrappedSdkErrorToHumanReadable: mockUnwrappedSdkErrorToHumanReadable
}))

import { alerts } from "@/lib/alerts"

beforeEach(() => {
	mockShowNotification.mockClear()
	mockUnwrapSdkError.mockReset()
	mockUnwrappedSdkErrorToHumanReadable.mockReset()
	// Default: not a SDK error
	mockUnwrapSdkError.mockReturnValue(null)
})

// ---------------------------------------------------------------------------
// Alerts.error — message dispatch / error-type branching
// ---------------------------------------------------------------------------

describe("Alerts.error — message dispatch / error-type branching", () => {
	it("uses unwrappedSdkErrorToHumanReadable when unwrapSdkError returns non-null (FilenSdkError path)", () => {
		const fakeUnwrapped = { kind: () => "Internal", message: () => "boom" }
		mockUnwrapSdkError.mockReturnValue(fakeUnwrapped)
		mockUnwrappedSdkErrorToHumanReadable.mockReturnValue("human readable SDK message")

		const fakeError = new Error("raw")
		alerts.error(fakeError)

		expect(mockUnwrapSdkError).toHaveBeenCalledWith(fakeError)
		expect(mockUnwrappedSdkErrorToHumanReadable).toHaveBeenCalledWith(fakeUnwrapped)
		expect(mockShowNotification).toHaveBeenCalledTimes(1)
		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { description: string }
		expect(callArgs.description).toBe("human readable SDK message")
	})

	it("uses error.message when unwrapSdkError returns null and input is a plain Error", () => {
		mockUnwrapSdkError.mockReturnValue(null)
		const plainError = new Error("plain error message")
		alerts.error(plainError)

		expect(mockUnwrappedSdkErrorToHumanReadable).not.toHaveBeenCalled()
		expect(mockShowNotification).toHaveBeenCalledTimes(1)
		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { description: string }
		expect(callArgs.description).toBe("plain error message")
	})

	it("uses String(message) when input is a string", () => {
		mockUnwrapSdkError.mockReturnValue(null)
		alerts.error("something went wrong")

		expect(mockShowNotification).toHaveBeenCalledTimes(1)
		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { description: string }
		expect(callArgs.description).toBe("something went wrong")
	})

	it("uses the stringified number when input is a number", () => {
		mockUnwrapSdkError.mockReturnValue(null)
		alerts.error(42)

		expect(mockShowNotification).toHaveBeenCalledTimes(1)
		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { description: string }
		expect(callArgs.description).toBe("42")
	})

	it("uses 'null' when input is null", () => {
		mockUnwrapSdkError.mockReturnValue(null)
		alerts.error(null)

		expect(mockShowNotification).toHaveBeenCalledTimes(1)
		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { description: string }
		expect(callArgs.description).toBe("null")
	})

	it("calls Notifier.showNotification exactly once per error() call", () => {
		mockUnwrapSdkError.mockReturnValue(null)
		alerts.error("one")
		alerts.error("two")
		expect(mockShowNotification).toHaveBeenCalledTimes(2)
	})

	it("sets the title to the i18n 'error' key", () => {
		mockUnwrapSdkError.mockReturnValue(null)
		alerts.error("x")

		const callArgs = mockShowNotification.mock.calls[0]?.[0] as { title: string }
		expect(callArgs.title).toBe("error")
	})
})
