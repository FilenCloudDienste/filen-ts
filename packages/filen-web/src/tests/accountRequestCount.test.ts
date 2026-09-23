// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType, type ReactNode } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type { UserInfo, UserPersonalUpdateInfo } from "@filen/sdk-rs"

const { getUserInfo, setNickname, updatePersonalInfo, setVersioningEnabled, setLoginAlertsEnabled, exportMasterKeys } = vi.hoisted(() => ({
	getUserInfo: vi.fn<() => Promise<UserInfo>>(),
	setNickname: vi.fn<(nickname?: string | null) => Promise<void>>(),
	updatePersonalInfo: vi.fn<(info: UserPersonalUpdateInfo) => Promise<void>>(),
	setVersioningEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
	setLoginAlertsEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
	exportMasterKeys: vi.fn<() => Promise<string>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { getUserInfo, setNickname, updatePersonalInfo, setVersioningEnabled, setLoginAlertsEnabled, exportMasterKeys }
}))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/settings/lib/downloadTextFile", () => ({ downloadTextFile: vi.fn() }))

import "@/lib/i18n"
import { settings as EN_SETTINGS } from "@/locales/en/settings"
import { auth as EN_AUTH } from "@/locales/en/auth"
import { queryClient } from "@/queries/client"
import {
	ACCOUNT_QUERY_KEY,
	ACCOUNT_STALE_TIME,
	accountQueryUpdate,
	markAccountStale,
	useAccountQuery,
	type AccountQuerySuccess
} from "@/queries/account"
import { NicknameCard } from "@/features/settings/components/account/nicknameCard"
import { PersonalInfoCard } from "@/features/settings/components/account/personalInfoCard"
import { AccountPreferencesCard } from "@/features/settings/components/account/accountPreferencesCard"
import { ExportMasterKeysCard } from "@/features/settings/components/security/exportMasterKeys"

const EMPTY_PERSONAL: UserPersonalUpdateInfo = {
	city: undefined,
	companyName: undefined,
	country: undefined,
	firstName: undefined,
	lastName: undefined,
	postalCode: undefined,
	street: undefined,
	streetNumber: undefined,
	vatId: undefined
}

const ACCOUNT: UserInfo = {
	id: 1n,
	email: "user@example.com",
	isPremium: false,
	storageUsed: 10n,
	maxStorage: 100n,
	avatarUrl: undefined,
	rootDirUuid: "root-0000-0000-0000-000000000000",
	twoFactorEnabled: false,
	twoFactorKey: undefined,
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
	personal: { ...EMPTY_PERSONAL, city: "Old City" },
	plans: [],
	refId: "",
	refLimit: 0n,
	refStorage: 0n,
	referCount: 0n,
	referStorage: 0n,
	nickName: "old",
	displayName: "old",
	appearOffline: false,
	subs: [],
	subsInvoices: [],
	didExportMasterKeys: false
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

function mountAccount() {
	return renderHook(() => useAccountQuery(), { wrapper })
}

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

function reads(): number {
	return getUserInfo.mock.calls.length
}

function cached(): UserInfo | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)
}

function isInvalidated(): boolean {
	return queryClient.getQueryCache().find({ queryKey: ACCOUNT_QUERY_KEY, exact: true })?.state.isInvalidated ?? false
}

function focus(): void {
	act(() => {
		focusManager.setFocused(false)
		focusManager.setFocused(true)
	})
}

// The settings route's own shape: one page-level useAccountQuery gating the card on success.
function renderCard(card: ComponentType<{ accountQuery: AccountQuerySuccess }>) {
	function Page() {
		const accountQuery = useAccountQuery()

		return accountQuery.status === "success" ? createElement(card, { accountQuery }) : null
	}

	return render(createElement(Page), { wrapper })
}

beforeEach(() => {
	queryClient.clear()
	getUserInfo.mockImplementation(() => Promise.resolve({ ...ACCOUNT }))
	setNickname.mockResolvedValue(undefined)
	updatePersonalInfo.mockResolvedValue(undefined)
	setVersioningEnabled.mockResolvedValue(undefined)
	setLoginAlertsEnabled.mockResolvedValue(undefined)
	exportMasterKeys.mockResolvedValue("keys")
})

afterEach(() => {
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("account request counts", () => {
	it("tab switches and focus inside the window reuse the account; focus past it reads again", async () => {
		// The shell's always-mounted meter/rail next to the one settings tab mounted at a time.
		mountAccount()
		await drain()

		expect(reads()).toBe(1)

		for (let i = 0; i < 3; i++) {
			mountAccount().unmount()
		}
		mountAccount()
		await drain()
		focus()
		focus()
		await drain()

		expect(reads()).toBe(1)

		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now + ACCOUNT_STALE_TIME + 1)
		focus()
		await drain()

		expect(reads()).toBe(2)
	})

	it("a network reconnect reads again inside the window", async () => {
		mountAccount()
		await drain()

		act(() => {
			onlineManager.setOnline(false)
			onlineManager.setOnline(true)
		})
		await drain()

		expect(reads()).toBe(2)
	})

	it("a storage write marks it stale without reading; the next focus reads once", async () => {
		mountAccount()
		await drain()

		markAccountStale()
		markAccountStale()
		await drain()

		expect(reads()).toBe(1)

		focus()
		await drain()
		focus()
		await drain()

		expect(reads()).toBe(2)
	})

	it("a mark during a read cancels it, so its possibly older answer can't clear the mark", async () => {
		mountAccount()
		await drain()

		const pending = deferred<UserInfo>()
		getUserInfo.mockImplementationOnce(() => pending.promise)
		void queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY })
		markAccountStale()
		pending.resolve({ ...ACCOUNT, storageUsed: 999n })
		await drain()

		expect(reads()).toBe(2)
		expect(cached()?.storageUsed).toBe(10n)
		expect(isInvalidated()).toBe(true)

		focus()
		await drain()

		expect(reads()).toBe(3)
	})

	it("a patch keeps a pending refresh pending", async () => {
		mountAccount()
		await drain()

		markAccountStale()
		accountQueryUpdate(prev => ({ ...prev, nickName: "patched" }))

		expect(cached()?.nickName).toBe("patched")
		expect(isInvalidated()).toBe(true)
	})

	it("a patch with nothing cached conjures no account", () => {
		accountQueryUpdate(prev => ({ ...prev, nickName: "patched" }))

		expect(cached()).toBeUndefined()
	})
})

describe("account writes patch instead of reading back", () => {
	it("saving a nickname patches it in", async () => {
		renderCard(NicknameCard)
		await drain()

		fireEvent.change(screen.getByLabelText(EN_SETTINGS.settingsNicknameTitle), { target: { value: "  fresh  " } })
		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsNicknameSave }))
		await drain()

		expect(setNickname).toHaveBeenCalledExactlyOnceWith("fresh")
		expect(cached()?.nickName).toBe("fresh")
		expect(reads()).toBe(1)
	})

	it("clearing the nickname patches it out", async () => {
		renderCard(NicknameCard)
		await drain()

		fireEvent.change(screen.getByLabelText(EN_SETTINGS.settingsNicknameTitle), { target: { value: " " } })
		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsNicknameSave }))
		await drain()

		expect(setNickname).toHaveBeenCalledExactlyOnceWith(null)
		expect(cached()?.nickName).toBeUndefined()
		expect(reads()).toBe(1)
	})

	it("a failed nickname save leaves the account untouched", async () => {
		setNickname.mockRejectedValue({ species: "plain", message: "boom", label: "boom" })
		renderCard(NicknameCard)
		await drain()

		fireEvent.change(screen.getByLabelText(EN_SETTINGS.settingsNicknameTitle), { target: { value: "fresh" } })
		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsNicknameSave }))
		await drain()

		expect(cached()?.nickName).toBe("old")
		expect(reads()).toBe(1)
	})

	it("saving personal info patches the whole record that was sent", async () => {
		renderCard(PersonalInfoCard)
		await drain()

		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsPersonalExpand }))
		fireEvent.change(screen.getByLabelText(EN_SETTINGS.settingsPersonalFirstName), { target: { value: " Ada " } })
		fireEvent.change(screen.getByLabelText(EN_SETTINGS.settingsPersonalCity), { target: { value: "" } })
		fireEvent.click(screen.getByRole("button", { name: EN_SETTINGS.settingsPersonalSave }))
		await drain()

		const sent = { ...EMPTY_PERSONAL, firstName: "Ada" }
		expect(updatePersonalInfo).toHaveBeenCalledExactlyOnceWith(sent)
		expect(cached()?.personal).toEqual(sent)
		expect(reads()).toBe(1)
	})

	it("flipping versioning and login alerts patches each flag", async () => {
		renderCard(AccountPreferencesCard)
		await drain()

		fireEvent.click(screen.getByRole("switch", { name: EN_SETTINGS.settingsVersioningTitle }))
		await drain()
		fireEvent.click(screen.getByRole("switch", { name: EN_SETTINGS.settingsLoginAlertsTitle }))
		await drain()

		expect(setVersioningEnabled).toHaveBeenCalledExactlyOnceWith(true)
		expect(setLoginAlertsEnabled).toHaveBeenCalledExactlyOnceWith(true)
		expect(cached()).toMatchObject({ versioningEnabled: true, loginAlertsEnabled: true })
		expect(reads()).toBe(1)
	})

	it("a failed toggle leaves the flag untouched", async () => {
		setVersioningEnabled.mockRejectedValue({ species: "plain", message: "boom", label: "boom" })
		renderCard(AccountPreferencesCard)
		await drain()

		fireEvent.click(screen.getByRole("switch", { name: EN_SETTINGS.settingsVersioningTitle }))
		await drain()

		expect(cached()?.versioningEnabled).toBe(false)
		expect(reads()).toBe(1)
	})

	it("exporting the master keys patches the exported flag", async () => {
		renderCard(ExportMasterKeysCard)
		await drain()

		fireEvent.click(screen.getByRole("button", { name: EN_AUTH.exportMasterKeysAction }))
		const dialog = await screen.findByRole("alertdialog")
		fireEvent.click(within(dialog).getByRole("button", { name: EN_AUTH.exportMasterKeysAction }))
		await drain()

		expect(exportMasterKeys).toHaveBeenCalledOnce()
		expect(cached()?.didExportMasterKeys).toBe(true)
		expect(reads()).toBe(1)
	})
})

// Read-this-session is module state, so these tests run against a fresh copy of the account module.
describe("account first read of the session", () => {
	it("a restored account is read on its first mount, then reused", async () => {
		vi.resetModules()
		const fresh = await import("@/queries/account")
		const { queryClient: freshClient } = await import("@/queries/client")
		freshClient.clear()
		freshClient.setQueryData(fresh.ACCOUNT_QUERY_KEY, { ...ACCOUNT }, { updatedAt: Date.now() })

		const freshWrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: freshClient, children })
		const first = renderHook(() => fresh.useAccountQuery(), { wrapper: freshWrapper })
		await waitFor(() => {
			expect(reads()).toBe(1)
		})
		await waitFor(() => {
			expect(freshClient.isFetching()).toBe(0)
		})

		first.unmount()
		renderHook(() => fresh.useAccountQuery(), { wrapper: freshWrapper })
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(reads()).toBe(1)
	})
})
