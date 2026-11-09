// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { StringifiedClient, UserInfo } from "@filen/sdk-rs"

// The Account and Security rows that patch the held account instead of reading it back, with only the
// worker boundary, the session store and the toasts mocked: getUserInfo's call count is the read count.
const { getUserInfo, changeEmail, disable2FA, changePassword } = vi.hoisted(() => ({
	getUserInfo: vi.fn<() => Promise<UserInfo>>(),
	changeEmail: vi.fn<(password: string, email: string) => Promise<void>>(),
	disable2FA: vi.fn<(code: string) => Promise<void>>(),
	changePassword: vi.fn<(params: { currentPassword: string; newPassword: string }) => Promise<StringifiedClient>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo, changeEmail, disable2FA, changePassword } }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(() => Promise.resolve()), clearSession: vi.fn(), broadcastAuth: vi.fn() }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

const { toastSuccess, toastError, toastWarning } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), toastWarning: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, warning: toastWarning } }))

import "@/lib/i18n"
import { i18n } from "@/lib/i18n"
import { settings as EN_SETTINGS } from "@/locales/en/settings"
import { auth as EN_AUTH } from "@/locales/en/auth"
import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { ACCOUNT_QUERY_KEY, useAccountQuery, useMasterKeysNotExported, type AccountQuerySuccess } from "@/queries/account"
import { addAccountStorageUsed } from "@/features/drive/lib/quota"
import { ChangeEmailRow } from "@/features/settings/components/account/changeEmail"
import { TwoFactorRow } from "@/features/settings/components/security/twoFactor"
import { ChangePasswordRow } from "@/features/settings/components/security/changePassword"

const ACCOUNT: UserInfo = {
	id: 1n,
	email: "user@example.com",
	isPremium: false,
	storageUsed: 10n,
	maxStorage: 100n,
	avatarUrl: undefined,
	rootDirUuid: "root-0000-0000-0000-000000000000",
	twoFactorEnabled: false,
	twoFactorKey: "SETUPKEY",
	unfinishedFiles: 0n,
	unfinishedStorage: 0n,
	versionedFiles: 0n,
	versionedStorage: 0n,
	versioningEnabled: false,
	loginAlertsEnabled: false,
	affBalance: 0,
	affCount: 0n,
	affEarnings: 0,
	affId: "",
	affRate: 0,
	personal: {
		city: undefined,
		companyName: undefined,
		country: undefined,
		firstName: undefined,
		lastName: undefined,
		postalCode: undefined,
		street: undefined,
		streetNumber: undefined,
		vatId: undefined
	},
	plans: [],
	refId: "",
	refLimit: 0n,
	refStorage: 0n,
	referCount: 0n,
	referStorage: 0n,
	nickName: undefined,
	displayName: "user",
	appearOffline: false,
	subs: [],
	subsInvoices: [],
	didExportMasterKeys: true
}

const wrapper = queryClientWrapper(queryClient)

async function drain(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

function cached(): UserInfo | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)
}

function renderRow(row: ComponentType<{ accountQuery: AccountQuerySuccess }>) {
	function Page() {
		const accountQuery = useAccountQuery()

		return accountQuery.status === "success" ? createElement(row, { accountQuery }) : null
	}

	return render(createElement(Page), { wrapper })
}

beforeEach(() => {
	queryClient.clear()
	getUserInfo.mockImplementation(() => Promise.resolve({ ...ACCOUNT }))
	changeEmail.mockResolvedValue(undefined)
	disable2FA.mockResolvedValue(undefined)
	changePassword.mockResolvedValue({ email: "user@example.com" } as StringifiedClient)
})

describe("change email", () => {
	// The server only records a pending change and mails a link: nothing local changes, nothing is read.
	it("says where the confirmation went, for long enough to act on, without reading or re-saving anything", async () => {
		renderRow(ChangeEmailRow)
		await drain()

		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsChangeEmailAction }))
		const dialog = await screen.findByRole("dialog")
		fireEvent.change(within(dialog).getByLabelText(EN_SETTINGS.settingsChangeEmailNew), { target: { value: "new@example.com" } })
		fireEvent.change(within(dialog).getByLabelText(EN_SETTINGS.settingsChangeEmailConfirm), { target: { value: "new@example.com" } })
		fireEvent.change(within(dialog).getByLabelText(EN_SETTINGS.settingsChangeEmailPassword), { target: { value: "pw" } })
		fireEvent.click(within(dialog).getByRole("button", { name: EN_SETTINGS.settingsChangeEmailAction }))
		await drain()

		expect(changeEmail).toHaveBeenCalledExactlyOnceWith("pw", "new@example.com")
		expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(i18n.t("settings:settingsChangeEmailSuccess", { email: "new@example.com" }), {
			duration: 10_000
		})
		expect(toastSuccess.mock.calls[0]?.[0]).toContain("new@example.com")
		expect(toastWarning).not.toHaveBeenCalled()
		expect(cached()?.email).toBe("user@example.com")
		expect(getUserInfo).toHaveBeenCalledOnce()
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
	})

	it("keeps the dialog open on a refusal", async () => {
		changeEmail.mockRejectedValue({ species: "plain", message: "boom", label: "boom" })
		renderRow(ChangeEmailRow)
		await drain()

		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsChangeEmailAction }))
		const dialog = await screen.findByRole("dialog")
		fireEvent.change(within(dialog).getByLabelText(EN_SETTINGS.settingsChangeEmailNew), { target: { value: "new@example.com" } })
		fireEvent.change(within(dialog).getByLabelText(EN_SETTINGS.settingsChangeEmailConfirm), { target: { value: "new@example.com" } })
		fireEvent.change(within(dialog).getByLabelText(EN_SETTINGS.settingsChangeEmailPassword), { target: { value: "pw" } })
		fireEvent.click(within(dialog).getByRole("button", { name: EN_SETTINGS.settingsChangeEmailAction }))
		await drain()

		expect(toastError).toHaveBeenCalledExactlyOnceWith("boom")
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(screen.getByRole("dialog")).toBeDefined()
	})
})

describe("disabling two-factor authentication", () => {
	it("confirms it, flips the row at once, and reads once for the new setup key", async () => {
		getUserInfo.mockImplementationOnce(() => Promise.resolve({ ...ACCOUNT, twoFactorEnabled: true, twoFactorKey: undefined }))
		renderRow(TwoFactorRow)
		await drain()

		fireEvent.click(screen.getByRole("button", { name: EN_AUTH.twoFactorDisableSubmit }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: EN_AUTH.twoFactorDisableSubmit }))
		const codeDialog = await screen.findByRole("dialog")
		fireEvent.change(within(codeDialog).getByLabelText(EN_AUTH.twoFactorCode), { target: { value: "123456" } })
		fireEvent.click(within(codeDialog).getByRole("button", { name: EN_AUTH.twoFactorDisableSubmit }))
		await drain()

		expect(disable2FA).toHaveBeenCalledExactlyOnceWith("123456")
		expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(EN_SETTINGS.settingsTwoFactorDisabledSuccess)
		expect(cached()).toMatchObject({ twoFactorEnabled: false, twoFactorKey: "SETUPKEY" })
		expect(getUserInfo).toHaveBeenCalledTimes(2)
	})
})

describe("changing the password", () => {
	it("brings the master-keys reminders back without reading the account now", async () => {
		renderRow(() => createElement(ChangePasswordRow))
		await drain()

		fireEvent.click(screen.getByRole("button", { name: EN_AUTH.changePasswordTitle }))
		const dialog = await screen.findByRole("dialog")
		fireEvent.change(within(dialog).getByLabelText(EN_AUTH.changePasswordCurrent), { target: { value: "old password" } })
		fireEvent.change(within(dialog).getByLabelText(EN_AUTH.changePasswordNew), { target: { value: "Tr0ub4dor&3-horse-staple" } })
		fireEvent.change(within(dialog).getByLabelText(EN_AUTH.changePasswordConfirm), { target: { value: "Tr0ub4dor&3-horse-staple" } })
		fireEvent.click(within(dialog).getByRole("button", { name: EN_AUTH.changePasswordSubmit }))
		await drain()

		expect(changePassword).toHaveBeenCalledOnce()
		expect(cached()?.didExportMasterKeys).toBe(false)
		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(true)
		expect(getUserInfo).toHaveBeenCalledOnce()
	})
})

describe("useMasterKeysNotExported", () => {
	it("follows the held account's export flag, never reading for it", async () => {
		getUserInfo.mockImplementation(() => Promise.resolve({ ...ACCOUNT, didExportMasterKeys: false }))

		const { result } = renderHook(() => useMasterKeysNotExported(), { wrapper })

		expect(result.current).toBe(false)
		await drain()
		expect(result.current).toBe(true)
		expect(getUserInfo).toHaveBeenCalledOnce()
	})

	// The account is patched once per uploaded file: the rail entry must not re-render for each.
	it("does not re-render its subscriber for a storage patch", async () => {
		let renders = 0

		renderHook(
			() => {
				renders++

				return useMasterKeysNotExported()
			},
			{ wrapper }
		)
		await drain()

		const settled = renders

		act(() => {
			addAccountStorageUsed(5n)
			addAccountStorageUsed(5n)
		})
		await drain()

		expect(renders).toBe(settled)
	})
})
