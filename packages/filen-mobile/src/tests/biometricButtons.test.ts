import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
import { type TFunction } from "i18next"
import { type Biometric } from "@/features/settings/screens/biometric"

// --- hoisted mocks ---
const { mockPromptsAlert, mockPromptsInput, mockAlertsError, mockFileProviderDisable, mockSetBiometric, mockSetFileProviderEnabled } =
	vi.hoisted(() => ({
		mockPromptsAlert: vi.fn(),
		mockPromptsInput: vi.fn(),
		mockAlertsError: vi.fn(),
		mockFileProviderDisable: vi.fn(),
		mockSetBiometric: vi.fn(),
		mockSetFileProviderEnabled: vi.fn()
	}))

vi.mock("@/lib/prompts", () => ({
	default: {
		alert: mockPromptsAlert,
		input: mockPromptsInput
	}
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: mockAlertsError }
}))

vi.mock("@/features/settings/fileProvider", () => ({
	default: {
		disable: mockFileProviderDisable
	}
}))

// Provide a minimal run() that actually invokes fn() and wraps the result.
// No defer support needed — biometricButtons.ts never registers deferred cleanups.
vi.mock("@filen/utils", () => ({
	run: async (fn: () => Promise<unknown>) => {
		try {
			return { success: true, data: await fn() }
		} catch (error) {
			return { success: false, error }
		}
	}
}))

// t() is a pass-through identity so assertions can use raw keys.
const t = ((key: string) => key) as unknown as TFunction

import { enableBiometric, disableBiometric } from "@/features/settings/biometricButtons"

// Helpers for common prompt results.
function alertConfirmed() {
	mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
}

function alertCancelled() {
	mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })
}

function inputReturns(value: string) {
	mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value })
}

function inputCancelled() {
	mockPromptsInput.mockResolvedValueOnce({ cancelled: true })
}

beforeEach(() => {
	vi.clearAllMocks()
	mockFileProviderDisable.mockResolvedValue(undefined)
})

// ────────────────────────────────────────────────────────────────────────────
// disableBiometric — trivial one-liner setter
// ────────────────────────────────────────────────────────────────────────────
describe("disableBiometric", () => {
	it("calls setBiometric with enabled: false", () => {
		disableBiometric({ setBiometric: mockSetBiometric as unknown as (value: Biometric) => void })

		expect(mockSetBiometric).toHaveBeenCalledOnce()
		expect(mockSetBiometric).toHaveBeenCalledWith({ enabled: false })
	})
})

// ────────────────────────────────────────────────────────────────────────────
// enableBiometric — finding #70 branches
// ────────────────────────────────────────────────────────────────────────────
describe("enableBiometric", () => {
	// Shared args used by most tests.  fileProviderEnabled defaults to false.
	function baseArgs(over: Partial<Parameters<typeof enableBiometric>[0]> = {}) {
		return {
			setBiometric: mockSetBiometric as unknown as (value: Biometric | ((prev: Biometric) => Biometric)) => void,
			fileProviderEnabled: false,
			setFileProviderEnabled: mockSetFileProviderEnabled as unknown as (value: boolean) => void,
			t,
			...over
		}
	}

	// ── A: fileProvider conflict branch ────────────────────────────────────

	describe("fileProvider conflict (fileProviderEnabled === true)", () => {
		it("does not show provider-disable alert when fileProviderEnabled is false", async () => {
			// Both password prompts need to be set up so the function completes.
			inputReturns("pass")
			inputReturns("pass")

			await enableBiometric(baseArgs({ fileProviderEnabled: false }))

			// prompts.alert is only called for the provider-disable confirmation — not for input prompts.
			expect(mockPromptsAlert).not.toHaveBeenCalled()
		})

		it("shows provider-disable confirmation when fileProviderEnabled is true", async () => {
			// User cancels at the confirmation step so we don't need to set up further prompts.
			alertCancelled()

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockPromptsAlert).toHaveBeenCalledOnce()
			expect(mockPromptsAlert.mock.calls[0]?.[0]?.title).toBe("biometric_disables_file_provider_title")
		})

		it("calls fileProvider.disable() and setFileProviderEnabled(false) when user confirms", async () => {
			// Confirm the provider-disable prompt, then supply two matching passwords.
			alertConfirmed()
			inputReturns("secret")
			inputReturns("secret")

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockFileProviderDisable).toHaveBeenCalledOnce()
			expect(mockSetFileProviderEnabled).toHaveBeenCalledWith(false)
		})

		it("does not call setBiometric when user cancels the provider-disable confirmation", async () => {
			alertCancelled()

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockSetBiometric).not.toHaveBeenCalled()
		})

		it("does not call fileProvider.disable() when user cancels the provider-disable confirmation", async () => {
			alertCancelled()

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockFileProviderDisable).not.toHaveBeenCalled()
		})

		it("calls alerts.error and aborts when fileProvider.disable() throws", async () => {
			// Confirm the warning, supply two matching passwords (validation passes),
			// then have disable() fail — biometric must not be set.
			alertConfirmed()
			inputReturns("pw")
			inputReturns("pw")
			mockFileProviderDisable.mockRejectedValueOnce(new Error("disable failed"))

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockAlertsError).toHaveBeenCalledOnce()
			expect(mockSetBiometric).not.toHaveBeenCalled()
		})

		// ── #53 fix: provider teardown deferred until password validated ──────

		it("does not call fileProvider.disable() when password step is cancelled after confirming warning", async () => {
			// User confirms the warning but then cancels the fallback-password prompt.
			// Before the fix: disable() was already called at that point.
			// After the fix: disable() must NOT be called.
			alertConfirmed()
			inputCancelled()

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockFileProviderDisable).not.toHaveBeenCalled()
			expect(mockSetFileProviderEnabled).not.toHaveBeenCalled()
			expect(mockSetBiometric).not.toHaveBeenCalled()
		})

		it("does not call fileProvider.disable() when passwords mismatch after confirming warning", async () => {
			// User confirms the warning then types mismatched passwords.
			// The mismatch must leave the provider intact.
			alertConfirmed()
			inputReturns("pass1")
			inputReturns("pass2")

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockFileProviderDisable).not.toHaveBeenCalled()
			expect(mockSetFileProviderEnabled).not.toHaveBeenCalled()
			expect(mockSetBiometric).not.toHaveBeenCalled()
		})
	})

	// ── B: fallback password mismatch ────────────────────────────────────

	describe("fallback password mismatch", () => {
		it("calls alerts.error with fallback_passwords_do_not_match when passwords differ", async () => {
			inputReturns("pass1")
			inputReturns("pass2")

			await enableBiometric(baseArgs())

			expect(mockAlertsError).toHaveBeenCalledOnce()
			expect(mockAlertsError).toHaveBeenCalledWith("fallback_passwords_do_not_match")
		})

		it("does not call setBiometric when passwords do not match", async () => {
			inputReturns("abc")
			inputReturns("xyz")

			await enableBiometric(baseArgs())

			expect(mockSetBiometric).not.toHaveBeenCalled()
		})
	})

	// ── C: user cancels password prompts ────────────────────────────────

	describe("user cancels password input", () => {
		it("does not call setBiometric when first password input is cancelled", async () => {
			inputCancelled()

			await enableBiometric(baseArgs())

			expect(mockSetBiometric).not.toHaveBeenCalled()
		})

		it("does not call setBiometric when second password input is cancelled", async () => {
			inputReturns("secret")
			inputCancelled()

			await enableBiometric(baseArgs())

			expect(mockSetBiometric).not.toHaveBeenCalled()
		})
	})

	// ── D: empty password guard ─────────────────────────────────────────

	describe("empty password guard", () => {
		it("does not call setBiometric when first password is empty string", async () => {
			inputReturns("")

			await enableBiometric(baseArgs())

			// The second prompt should not even be shown
			expect(mockPromptsInput).toHaveBeenCalledOnce()
			expect(mockSetBiometric).not.toHaveBeenCalled()
		})

		it("does not call setBiometric when confirm password is empty string", async () => {
			inputReturns("pass")
			inputReturns("")

			await enableBiometric(baseArgs())

			expect(mockSetBiometric).not.toHaveBeenCalled()
		})
	})

	// ── E: happy path ───────────────────────────────────────────────────

	describe("happy path", () => {
		it("calls setBiometric with enabled: true and the supplied fallback password", async () => {
			inputReturns("mySecret")
			inputReturns("mySecret")

			await enableBiometric(baseArgs())

			expect(mockSetBiometric).toHaveBeenCalledOnce()
			expect(mockSetBiometric).toHaveBeenCalledWith({
				lockAfter: 0,
				enabled: true,
				fallback: "mySecret",
				lockedUntil: 0,
				pinOnly: false,
				lockedMultiplier: 1
			})
		})

		it("does not call alerts.error on the happy path", async () => {
			inputReturns("correct")
			inputReturns("correct")

			await enableBiometric(baseArgs())

			expect(mockAlertsError).not.toHaveBeenCalled()
		})

		it("calls fileProvider.disable() and setBiometric when fileProvider is enabled and user confirms", async () => {
			alertConfirmed()
			inputReturns("pw")
			inputReturns("pw")

			await enableBiometric(baseArgs({ fileProviderEnabled: true }))

			expect(mockFileProviderDisable).toHaveBeenCalledOnce()
			expect(mockSetFileProviderEnabled).toHaveBeenCalledWith(false)
			expect(mockSetBiometric).toHaveBeenCalledOnce()
			expect(mockSetBiometric).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, fallback: "pw" }))
		})
	})
})
