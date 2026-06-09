import { vi, describe, it, expect, beforeEach } from "vitest"

// --- hoisted mocks -----------------------------------------------------------

const {
	mockPromptsAlert,
	mockPromptsInput,
	mockAlertsError,
	mockAlertsNormal,
	mockGetSdkClients,
	mockAuthedSdkClient,
	mockRunWithLoading,
	mockRouterPush,
	mockCanOpenURL,
	mockOpenURL,
	mockRefetch
} = vi.hoisted(() => {
	const mockAuthedSdkClient = {
		deleteAllVersions: vi.fn(),
		deleteAllItems: vi.fn(),
		deleteAccount: vi.fn(),
		changeEmail: vi.fn(),
		setVersioningEnabled: vi.fn(),
		setLoginAlertsEnabled: vi.fn(),
		disable2fa: vi.fn(),
		enable2faGetRecoveryKey: vi.fn()
	}

	const mockRefetch = vi.fn()

	return {
		mockPromptsAlert: vi.fn(),
		mockPromptsInput: vi.fn(),
		mockAlertsError: vi.fn(),
		mockAlertsNormal: vi.fn(),
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockAuthedSdkClient }),
		mockAuthedSdkClient,
		mockRunWithLoading: vi.fn(),
		mockRouterPush: vi.fn(),
		mockCanOpenURL: vi.fn(),
		mockOpenURL: vi.fn(),
		mockRefetch
	}
})

vi.mock("@/lib/prompts", () => ({
	default: {
		alert: mockPromptsAlert,
		input: mockPromptsInput
	}
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: mockAlertsError,
		normal: mockAlertsNormal
	}
}))

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: mockGetSdkClients }
}))

vi.mock("@/lib/i18n", () => ({
	t: (key: string) => key,
	default: { t: (key: string) => key }
}))

vi.mock("expo-router", () => ({
	router: { push: mockRouterPush }
}))

vi.mock("expo-linking", () => ({
	canOpenURL: mockCanOpenURL,
	openURL: mockOpenURL
}))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	formatBytes: (n: number) => `${n}B`
}))

vi.mock("@/lib/serializer", () => ({
	serialize: vi.fn(x => JSON.stringify(x))
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: mockRunWithLoading
}))

// shareTmpFile + newTmpFile: not exercised in the branches we test, provide no-op stubs
vi.mock("@/lib/share", () => ({
	shareTmpFile: vi.fn()
}))

vi.mock("@/lib/tmp", () => ({
	newTmpFile: vi.fn(() => ({
		uri: "file:///tmp/file.txt",
		name: "file.txt",
		exists: false,
		write: vi.fn(),
		delete: vi.fn()
	}))
}))

vi.mock("@/lib/utils", () => ({
	convertBigInts: vi.fn(x => x)
}))

// settingsGroup.tsx imports native UI: mock it to avoid transform failures
vi.mock("@/components/ui/settingsGroup", () => ({}))
vi.mock("@/queries/useAccount.query", () => ({ default: vi.fn() }))
vi.mock("uniwind", () => ({
	useResolveClassNames: vi.fn(() => ({ color: "#ff0000" }))
}))

import {
	buildDangerZoneButtons,
	buildProfileButtons,
	buildAccountToggleButtons,
	buildTwoFactorButtons
} from "@/features/settings/accountButtons"
import type { TFunction } from "i18next"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const t = ((key: string) => key) as TFunction

const textRed500 = { color: "#ef4444" } as ReturnType<typeof import("uniwind").useResolveClassNames>

type AccountQuerySuccess = Parameters<typeof buildDangerZoneButtons>[0]["accountQuery"]

function makeAccountQuery(
	overrides: Partial<{
		versionedStorage: bigint
		storageUsed: bigint
		twoFactorEnabled: boolean
		versioningEnabled: boolean
		loginAlertsEnabled: boolean
		email: string
		nickName: string
		personal: unknown
	}> = {}
): AccountQuerySuccess {
	return {
		status: "success" as const,
		data: {
			versionedStorage: 1000n,
			storageUsed: 2000n,
			twoFactorEnabled: false,
			versioningEnabled: true,
			loginAlertsEnabled: true,
			email: "user@example.com",
			nickName: "user",
			personal: {},
			...overrides
		},
		refetch: mockRefetch
	} as unknown as AccountQuerySuccess
}

/** Confirm all prompts (never cancel). */
function alwaysConfirm() {
	mockPromptsAlert.mockResolvedValue({ cancelled: false })
}

/** Make runWithLoading actually execute its callback. */
function runWithLoadingPassthrough() {
	mockRunWithLoading.mockImplementation(async (fn: () => Promise<unknown>) => {
		try {
			const data = await fn()

			return { success: true, data }
		} catch (error) {
			return { success: false, error }
		}
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	// sensible defaults
	mockPromptsAlert.mockResolvedValue({ cancelled: false })
	mockPromptsInput.mockResolvedValue({ cancelled: false, type: "string", value: "" })
	mockRunWithLoading.mockResolvedValue({ success: true, data: undefined })
	mockCanOpenURL.mockResolvedValue(true)
	mockOpenURL.mockResolvedValue(undefined)
	mockRefetch.mockResolvedValue(undefined)
	mockAuthedSdkClient.deleteAllVersions.mockResolvedValue(undefined)
	mockAuthedSdkClient.deleteAllItems.mockResolvedValue(undefined)
	mockAuthedSdkClient.deleteAccount.mockResolvedValue(undefined)
	mockAuthedSdkClient.changeEmail.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// buildDangerZoneButtons
// ---------------------------------------------------------------------------

describe("buildDangerZoneButtons", () => {
	it("returns exactly 3 buttons", () => {
		const buttons = buildDangerZoneButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: true,
			textRed500
		})

		expect(buttons).toHaveLength(3)
	})

	it("all buttons have disabled===true when isOnline===false", () => {
		const buttons = buildDangerZoneButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: false,
			textRed500
		})

		for (const btn of buttons) {
			expect(btn.disabled).toBe(true)
		}
	})

	it("all buttons have disabled===false when isOnline===true", () => {
		const buttons = buildDangerZoneButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: true,
			textRed500
		})

		for (const btn of buttons) {
			expect(btn.disabled).toBe(false)
		}
	})

	describe("delete versioned files button — versionedStorage guard", () => {
		it("does NOT call prompts.alert when versionedStorage===0n", async () => {
			const accountQuery = makeAccountQuery({ versionedStorage: 0n })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[0]

			await btn?.onPress?.()

			expect(mockPromptsAlert).not.toHaveBeenCalled()
		})

		it("does NOT call prompts.alert when versionedStorage===0 (number coercion stays falsy)", async () => {
			// bigint 0n <= 0 is true in JS — the guard fires for 0n
			const accountQuery = makeAccountQuery({ versionedStorage: 0n })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[0]

			await btn?.onPress?.()

			expect(mockPromptsAlert).not.toHaveBeenCalled()
		})

		it("calls prompts.alert when versionedStorage > 0n and confirmed twice → calls deleteAllVersions", async () => {
			alwaysConfirm()
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ versionedStorage: 1000n })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[0]

			await btn?.onPress?.()

			// Two confirmation dialogs
			expect(mockPromptsAlert).toHaveBeenCalledTimes(2)
			expect(mockAuthedSdkClient.deleteAllVersions).toHaveBeenCalledTimes(1)
		})

		it("aborts after first cancel without calling deleteAllVersions", async () => {
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ versionedStorage: 1000n })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[0]

			await btn?.onPress?.()

			expect(mockAuthedSdkClient.deleteAllVersions).not.toHaveBeenCalled()
		})
	})

	describe("delete all files button — storageUsed guard", () => {
		it("does NOT call prompts.alert when storageUsed===0n", async () => {
			const accountQuery = makeAccountQuery({ storageUsed: 0n })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[1]

			await btn?.onPress?.()

			expect(mockPromptsAlert).not.toHaveBeenCalled()
		})

		it("calls deleteAllItems when storageUsed > 0n and confirmed twice", async () => {
			alwaysConfirm()
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ storageUsed: 5000n })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[1]

			await btn?.onPress?.()

			expect(mockAuthedSdkClient.deleteAllItems).toHaveBeenCalledTimes(1)
		})
	})

	describe("request account deletion button — 2FA branch", () => {
		it("skips 2FA prompt when twoFactorEnabled===false and calls deleteAccount(undefined)", async () => {
			alwaysConfirm()
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: false })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[2]

			await btn?.onPress?.()

			expect(mockPromptsInput).not.toHaveBeenCalled()
			expect(mockAuthedSdkClient.deleteAccount).toHaveBeenCalledTimes(1)
			expect(mockAuthedSdkClient.deleteAccount).toHaveBeenCalledWith(undefined)
		})

		it("shows 2FA input and forwards code when twoFactorEnabled===true", async () => {
			// Confirm the two alert prompts then provide 2FA code
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false }).mockResolvedValueOnce({ cancelled: false })
			mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value: "123456" })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: true })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[2]

			await btn?.onPress?.()

			expect(mockPromptsInput).toHaveBeenCalledTimes(1)
			expect(mockAuthedSdkClient.deleteAccount).toHaveBeenCalledTimes(1)
			expect(mockAuthedSdkClient.deleteAccount).toHaveBeenCalledWith("123456")
		})

		it("aborts when 2FA prompt is cancelled", async () => {
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false }).mockResolvedValueOnce({ cancelled: false })
			mockPromptsInput.mockResolvedValueOnce({ cancelled: true })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: true })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[2]

			await btn?.onPress?.()

			expect(mockAuthedSdkClient.deleteAccount).not.toHaveBeenCalled()
		})

		it("aborts when 2FA code is empty string", async () => {
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false }).mockResolvedValueOnce({ cancelled: false })
			mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value: "" })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: true })
			const buttons = buildDangerZoneButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true,
				textRed500
			})
			const btn = buttons[2]

			await btn?.onPress?.()

			expect(mockAuthedSdkClient.deleteAccount).not.toHaveBeenCalled()
		})
	})
})

// ---------------------------------------------------------------------------
// buildProfileButtons
// ---------------------------------------------------------------------------

describe("buildProfileButtons", () => {
	it("returns buttons array with expected items", () => {
		const buttons = buildProfileButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: true
		})

		// At minimum the 5 known buttons
		expect(buttons.length).toBeGreaterThanOrEqual(5)
	})

	describe("change email — email mismatch guard", () => {
		it("calls alerts.error with email_addresses_do_not_match and does NOT call getSdkClients", async () => {
			// newEmail prompt
			mockPromptsInput
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "new@example.com" })
				// confirmNewEmail prompt (different value)
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "other@example.com" })

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			const changeEmailBtn = buttons[0]

			await changeEmailBtn?.onPress?.()

			expect(mockAlertsError).toHaveBeenCalledTimes(1)
			expect(mockAlertsError).toHaveBeenCalledWith("email_addresses_do_not_match")
			expect(mockGetSdkClients).not.toHaveBeenCalled()
		})

		it("does NOT call alerts.error when emails match", async () => {
			mockPromptsInput
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "new@example.com" })
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "new@example.com" })
				// password prompt
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "secret" })
			runWithLoadingPassthrough()

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			const changeEmailBtn = buttons[0]

			await changeEmailBtn?.onPress?.()

			expect(mockAlertsError).not.toHaveBeenCalledWith("email_addresses_do_not_match")
		})
	})

	describe("change email — empty newEmail guard", () => {
		it("short-circuits without calling confirmEmail prompt when newEmail is empty after trim", async () => {
			mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value: "   " })

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			const changeEmailBtn = buttons[0]

			await changeEmailBtn?.onPress?.()

			// Only one input call (for the first email prompt)
			expect(mockPromptsInput).toHaveBeenCalledTimes(1)
			expect(mockGetSdkClients).not.toHaveBeenCalled()
		})
	})

	describe("change email — empty confirmNewEmail guard", () => {
		it("short-circuits without calling password prompt when confirmNewEmail is empty after trim", async () => {
			mockPromptsInput
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "new@example.com" })
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "   " })

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			const changeEmailBtn = buttons[0]

			await changeEmailBtn?.onPress?.()

			// Two input calls (new email + confirm), then short-circuit before password
			expect(mockPromptsInput).toHaveBeenCalledTimes(2)
			expect(mockGetSdkClients).not.toHaveBeenCalled()
		})
	})

	describe("change email — empty password guard", () => {
		it("short-circuits without calling getSdkClients when password is empty", async () => {
			mockPromptsInput
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "new@example.com" })
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "new@example.com" })
				// empty password
				.mockResolvedValueOnce({ cancelled: false, type: "string", value: "" })

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			const changeEmailBtn = buttons[0]

			await changeEmailBtn?.onPress?.()

			expect(mockGetSdkClients).not.toHaveBeenCalled()
		})
	})

	describe("more account settings — canOpenURL===false", () => {
		it("calls alerts.error with cannot_open_link when canOpenURL returns false", async () => {
			// Confirm the open-web-app alert
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
			mockCanOpenURL.mockResolvedValueOnce(false)

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			// "more_account_settings" is the last button (index 4)
			const moreBtn = buttons[4]

			await moreBtn?.onPress?.()

			expect(mockAlertsError).toHaveBeenCalledTimes(1)
			expect(mockAlertsError).toHaveBeenCalledWith("cannot_open_link")
			expect(mockOpenURL).not.toHaveBeenCalled()
		})

		it("calls openURL when canOpenURL returns true", async () => {
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
			mockCanOpenURL.mockResolvedValueOnce(true)
			mockOpenURL.mockResolvedValueOnce(undefined)

			const buttons = buildProfileButtons({
				t,
				accountQuery: makeAccountQuery(),
				isOnline: true
			})
			const moreBtn = buttons[4]

			await moreBtn?.onPress?.()

			expect(mockOpenURL).toHaveBeenCalledTimes(1)
			expect(mockAlertsError).not.toHaveBeenCalledWith("cannot_open_link")
		})
	})
})

// ---------------------------------------------------------------------------
// buildAccountToggleButtons
// ---------------------------------------------------------------------------

describe("buildAccountToggleButtons", () => {
	it("returns exactly 2 buttons", () => {
		const buttons = buildAccountToggleButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: true
		})

		expect(buttons).toHaveLength(2)
	})

	it("file-versioning switch value mirrors accountQuery.data.versioningEnabled (true)", () => {
		const buttons = buildAccountToggleButtons({
			t,
			accountQuery: makeAccountQuery({ versioningEnabled: true }),
			isOnline: true
		})
		const btn = buttons[0]

		expect(btn?.rightItem).toBeDefined()
		expect(btn?.rightItem?.type).toBe("switch")

		if (btn?.rightItem?.type === "switch") {
			expect(btn.rightItem.value).toBe(true)
		}
	})

	it("file-versioning switch value mirrors accountQuery.data.versioningEnabled (false)", () => {
		const buttons = buildAccountToggleButtons({
			t,
			accountQuery: makeAccountQuery({ versioningEnabled: false }),
			isOnline: true
		})
		const btn = buttons[0]

		if (btn?.rightItem?.type === "switch") {
			expect(btn.rightItem.value).toBe(false)
		}
	})

	it("login-alerts switch value mirrors accountQuery.data.loginAlertsEnabled (true)", () => {
		const buttons = buildAccountToggleButtons({
			t,
			accountQuery: makeAccountQuery({ loginAlertsEnabled: true }),
			isOnline: true
		})
		const btn = buttons[1]

		if (btn?.rightItem?.type === "switch") {
			expect(btn.rightItem.value).toBe(true)
		}
	})

	it("login-alerts switch value mirrors accountQuery.data.loginAlertsEnabled (false)", () => {
		const buttons = buildAccountToggleButtons({
			t,
			accountQuery: makeAccountQuery({ loginAlertsEnabled: false }),
			isOnline: true
		})
		const btn = buttons[1]

		if (btn?.rightItem?.type === "switch") {
			expect(btn.rightItem.value).toBe(false)
		}
	})

	it("both buttons are disabled when isOnline===false", () => {
		const buttons = buildAccountToggleButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: false
		})

		for (const btn of buttons) {
			expect(btn.disabled).toBe(true)
		}
	})
})

// ---------------------------------------------------------------------------
// buildTwoFactorButtons
// ---------------------------------------------------------------------------

describe("buildTwoFactorButtons", () => {
	it("returns exactly 1 button", () => {
		const buttons = buildTwoFactorButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: true
		})

		expect(buttons).toHaveLength(1)
	})

	it("2FA switch is disabled when isOnline===false", () => {
		const buttons = buildTwoFactorButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: false
		})

		expect(buttons[0]?.disabled).toBe(true)
	})

	it("2FA switch is not disabled when isOnline===true", () => {
		const buttons = buildTwoFactorButtons({
			t,
			accountQuery: makeAccountQuery(),
			isOnline: true
		})

		expect(buttons[0]?.disabled).toBe(false)
	})

	it("switch value mirrors accountQuery.data.twoFactorEnabled (false)", () => {
		const buttons = buildTwoFactorButtons({
			t,
			accountQuery: makeAccountQuery({ twoFactorEnabled: false }),
			isOnline: true
		})
		const btn = buttons[0]

		if (btn?.rightItem?.type === "switch") {
			expect(btn.rightItem.value).toBe(false)
		}
	})

	it("switch value mirrors accountQuery.data.twoFactorEnabled (true)", () => {
		const buttons = buildTwoFactorButtons({
			t,
			accountQuery: makeAccountQuery({ twoFactorEnabled: true }),
			isOnline: true
		})
		const btn = buttons[0]

		if (btn?.rightItem?.type === "switch") {
			expect(btn.rightItem.value).toBe(true)
		}
	})

	describe("disable flow (twoFactorEnabled===true)", () => {
		it("calls disable2fa with the provided code", async () => {
			// Confirm the disable alert, then provide 2FA code via input
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
			mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value: "654321" })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: true })
			const buttons = buildTwoFactorButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true
			})
			const btn = buttons[0]

			if (btn?.rightItem?.type === "switch") {
				await btn.rightItem.onValueChange(false)
			}

			expect(mockAuthedSdkClient.disable2fa).toHaveBeenCalledTimes(1)
			expect(mockAuthedSdkClient.disable2fa).toHaveBeenCalledWith("654321")
		})

		it("aborts disable when 2FA prompt is cancelled", async () => {
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
			mockPromptsInput.mockResolvedValueOnce({ cancelled: true })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: true })
			const buttons = buildTwoFactorButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true
			})
			const btn = buttons[0]

			if (btn?.rightItem?.type === "switch") {
				await btn.rightItem.onValueChange(false)
			}

			expect(mockAuthedSdkClient.disable2fa).not.toHaveBeenCalled()
		})

		it("aborts disable when confirm alert is cancelled", async () => {
			mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: true })
			const buttons = buildTwoFactorButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true
			})
			const btn = buttons[0]

			if (btn?.rightItem?.type === "switch") {
				await btn.rightItem.onValueChange(false)
			}

			expect(mockAuthedSdkClient.disable2fa).not.toHaveBeenCalled()
		})
	})

	describe("enable flow (twoFactorEnabled===false)", () => {
		it("calls enable2faGetRecoveryKey with the provided code", async () => {
			mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value: "123456" })
			mockAuthedSdkClient.enable2faGetRecoveryKey.mockResolvedValueOnce("recovery-key-abc")
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: false })
			const buttons = buildTwoFactorButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true
			})
			const btn = buttons[0]

			if (btn?.rightItem?.type === "switch") {
				await btn.rightItem.onValueChange(true)
			}

			expect(mockAuthedSdkClient.enable2faGetRecoveryKey).toHaveBeenCalledTimes(1)
			expect(mockAuthedSdkClient.enable2faGetRecoveryKey).toHaveBeenCalledWith("123456")
		})

		it("aborts enable when 2FA code prompt is cancelled", async () => {
			mockPromptsInput.mockResolvedValueOnce({ cancelled: true })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: false })
			const buttons = buildTwoFactorButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true
			})
			const btn = buttons[0]

			if (btn?.rightItem?.type === "switch") {
				await btn.rightItem.onValueChange(true)
			}

			expect(mockAuthedSdkClient.enable2faGetRecoveryKey).not.toHaveBeenCalled()
		})

		it("aborts enable when 2FA code is empty string", async () => {
			mockPromptsInput.mockResolvedValueOnce({ cancelled: false, type: "string", value: "" })
			runWithLoadingPassthrough()

			const accountQuery = makeAccountQuery({ twoFactorEnabled: false })
			const buttons = buildTwoFactorButtons({
				t,
				accountQuery: accountQuery,
				isOnline: true
			})
			const btn = buttons[0]

			if (btn?.rightItem?.type === "switch") {
				await btn.rightItem.onValueChange(true)
			}

			expect(mockAuthedSdkClient.enable2faGetRecoveryKey).not.toHaveBeenCalled()
		})
	})
})
