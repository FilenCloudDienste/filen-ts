// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { auth as EN_AUTH } from "@/locales/en/auth"
import { AccountReminders } from "@/features/shell/components/accountReminders"
import { openStorageFull, useReminderStore } from "@/features/shell/store/useReminderStore"
import { settings as EN_SETTINGS } from "@/locales/en/settings"

// Covers the wiring the e2e suite deliberately no longer exercises. src/main.tsx latches both reminders
// closed before the first render, because a standing modal aria-hides the whole shell and made every
// later locator in the suite match nothing. That trade only holds if the component itself is pinned
// here: both dismissal paths and the keys-before-storage sequencing through two different dialog
// primitives.

const { useAccountQuery, navigate } = vi.hoisted(() => ({
	useAccountQuery: vi.fn(),
	navigate: vi.fn()
}))

vi.mock("@/queries/account", () => ({ useAccountQuery }))

const { desktopBridge } = vi.hoisted(() => ({ desktopBridge: vi.fn<() => object | undefined>(() => undefined) }))

vi.mock("@/lib/desktop", () => ({ desktopBridge }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))

// Read from the catalog rather than retyped: a hardcoded copy that drifts turns every queryByText
// assertion below into one that passes because it found nothing, which is the exact shape of a test
// that cannot fail. Resolving through the same keys the component uses also catches it rendering a
// raw key.
const KEYS_TITLE = EN_AUTH.exportMasterKeysReminderTitle
const KEYS_DISMISS = EN_AUTH.exportMasterKeysReminderDismiss
const KEYS_ACTION = EN_AUTH.exportMasterKeysReminderAction
const STORAGE_TITLE = EN_AUTH.storageLimitReminderTitle
const STORAGE_DISMISS = EN_AUTH.storageLimitReminderDismiss

const OVER_LIMIT = { storageUsed: 20n, maxStorage: 10n }
const UNDER_LIMIT = { storageUsed: 1n, maxStorage: 10n }

function account(overrides: { didExportMasterKeys?: boolean; storageUsed?: bigint; maxStorage?: bigint } = {}) {
	return {
		status: "success" as const,
		data: { didExportMasterKeys: true, ...UNDER_LIMIT, ...overrides }
	}
}

function renderReminders(): void {
	render(createElement(AccountReminders))
}

// The store lives for the page load, so a test that dismisses one reminder would otherwise decide the
// next one's starting state.
beforeEach(() => {
	useReminderStore.setState({ keysDismissed: false, storageDismissed: false, storageFullRequested: false })
})

describe("AccountReminders", () => {
	it("raises the export-keys reminder when the account has not exported them", () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		renderReminders()

		expect(screen.getByText(KEYS_TITLE)).toBeDefined()
	})

	it("stays silent while the account query is still pending", () => {
		// The gate reads accountStatus, not just the data: a pending query must not flash a reminder
		// whose condition is not known yet.
		useAccountQuery.mockReturnValue({ status: "pending" as const, data: undefined })

		renderReminders()

		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
	})

	it("dismissing the keys reminder closes it and latches only its own flag", () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		renderReminders()

		fireEvent.click(screen.getByRole("button", { name: KEYS_DISMISS }))

		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
		// The store, not component state: it is what keeps the reminder down for the rest of the page
		// LOAD, across every remount of this component.
		expect(useReminderStore.getState()).toMatchObject({ keysDismissed: true, storageDismissed: false })
	})

	it("confirming navigates to the security section and closes the reminder", () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		renderReminders()

		fireEvent.click(screen.getByRole("button", { name: KEYS_ACTION }))

		expect(navigate).toHaveBeenCalledWith({ to: "/settings/security" })
		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
	})

	it("holds the storage reminder behind the keys one, then raises it once keys are dismissed", () => {
		// Both conditions true at once. selectActiveReminder returns ONE kind, keys first — so the
		// storage dialog must not mount until the keys one is gone. This ordering is what the e2e
		// helper's two-stage dismissal was built around.
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false, ...OVER_LIMIT }))

		renderReminders()

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: KEYS_DISMISS }))

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()
	})

	it("dismissing the storage reminder closes it and latches its own flag", () => {
		useAccountQuery.mockReturnValue(account(OVER_LIMIT))

		renderReminders()

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: STORAGE_DISMISS }))

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
		expect(useReminderStore.getState()).toMatchObject({ keysDismissed: false, storageDismissed: true })
	})

	it("raises nothing for an account that exported its keys and is under quota", () => {
		useAccountQuery.mockReturnValue(account())

		renderReminders()

		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
	})

	it("treats an exact fill as over the limit, and a 0-byte quota as unknown", () => {
		useAccountQuery.mockReturnValue(account({ storageUsed: 10n, maxStorage: 10n }))

		const full = render(createElement(AccountReminders))

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()

		full.unmount()
		useReminderStore.setState({ storageDismissed: false })
		useAccountQuery.mockReturnValue(account({ storageUsed: 0n, maxStorage: 0n }))

		renderReminders()

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
	})
})

describe("the storage-full dialog on demand", () => {
	const UPGRADE = EN_SETTINGS.settingsStorageFullUpgrade

	it("opens when a refusal asks for it, even once the boot reminder was dismissed, and closes on dismiss", () => {
		useAccountQuery.mockReturnValue(account())
		useReminderStore.setState({ storageDismissed: true })

		renderReminders()

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()

		act(() => {
			openStorageFull()
		})

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: STORAGE_DISMISS }))

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
		expect(useReminderStore.getState().storageFullRequested).toBe(false)
	})

	it("waits behind the keys reminder rather than stacking on it", () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		renderReminders()
		act(() => {
			openStorageFull()
		})

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: KEYS_DISMISS }))

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()
	})

	it("Upgrade opens billing in the app on the web", () => {
		useAccountQuery.mockReturnValue(account(OVER_LIMIT))

		renderReminders()
		fireEvent.click(screen.getByRole("button", { name: UPGRADE }))

		expect(navigate).toHaveBeenCalledWith({ to: "/settings/billing" })
		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
	})

	it("Upgrade opens the web app's billing in the browser on desktop", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null)
		desktopBridge.mockReturnValue({})
		useAccountQuery.mockReturnValue(account(OVER_LIMIT))

		renderReminders()
		fireEvent.click(screen.getByRole("button", { name: UPGRADE }))

		expect(open).toHaveBeenCalledWith("https://app.filen.io/settings/billing", "_blank", "noopener,noreferrer")
		expect(navigate).not.toHaveBeenCalled()
	})
})
