// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { auth as EN_AUTH } from "@/locales/en/auth"

// Covers the wiring the e2e suite deliberately no longer exercises. src/e2e-hooks/index.ts latches both
// reminders closed before the first render, because a standing modal aria-hides the whole shell and made
// every later locator in the suite match nothing. That trade only holds if the component itself is
// pinned here: the seeding from module state, both dismissal paths, and the keys-before-storage
// sequencing through two different dialog primitives.
//
// Fresh import per test, the same idiom exportMasterKeys.test.ts uses: the fired flags are module-level
// singletons with no reset seam, so a test that dismisses one would otherwise decide the next one's
// starting state.

const { useAccountQuery, navigate } = vi.hoisted(() => ({
	useAccountQuery: vi.fn(),
	navigate: vi.fn()
}))

vi.mock("@/queries/account", () => ({ useAccountQuery }))
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

async function renderReminders(): Promise<void> {
	const { AccountReminders } = await import("@/features/shell/components/accountReminders")

	render(createElement(AccountReminders))
}

beforeEach(() => {
	vi.resetModules()
})

describe("AccountReminders", () => {
	it("raises the export-keys reminder when the account has not exported them", async () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		await renderReminders()

		expect(screen.getByText(KEYS_TITLE)).toBeDefined()
	})

	it("stays silent while the account query is still pending", async () => {
		// The gate reads accountStatus, not just the data: a pending query must not flash a reminder
		// whose condition is not known yet.
		useAccountQuery.mockReturnValue({ status: "pending" as const, data: undefined })

		await renderReminders()

		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
	})

	it("dismissing the keys reminder closes it and latches the module flag", async () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		const logic = await import("@/features/settings/components/security/exportMasterKeys.logic")
		await renderReminders()

		fireEvent.click(screen.getByRole("button", { name: KEYS_DISMISS }))

		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
		// The flag, not just local state: it is what keeps the reminder down for the rest of the page
		// LOAD, across every remount of this component.
		expect(logic.reminderFired()).toBe(true)
	})

	it("confirming navigates to the security section and closes the reminder", async () => {
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false }))

		await renderReminders()

		fireEvent.click(screen.getByRole("button", { name: KEYS_ACTION }))

		expect(navigate).toHaveBeenCalledWith({ to: "/settings/security" })
		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
	})

	it("holds the storage reminder behind the keys one, then raises it once keys are dismissed", async () => {
		// Both conditions true at once. selectActiveReminder returns ONE kind, keys first — so the
		// storage dialog must not mount until the keys one is gone. This ordering is what the e2e
		// helper's two-stage dismissal was built around.
		useAccountQuery.mockReturnValue(account({ didExportMasterKeys: false, ...OVER_LIMIT }))

		await renderReminders()

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: KEYS_DISMISS }))

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()
	})

	it("dismissing the storage reminder closes it and latches its own flag", async () => {
		useAccountQuery.mockReturnValue(account(OVER_LIMIT))

		const logic = await import("@/features/settings/components/security/exportMasterKeys.logic")
		await renderReminders()

		expect(screen.getByText(STORAGE_TITLE)).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: STORAGE_DISMISS }))

		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
		expect(logic.storageReminderFired()).toBe(true)
	})

	it("raises nothing for an account that exported its keys and is under quota", async () => {
		useAccountQuery.mockReturnValue(account())

		await renderReminders()

		expect(screen.queryByText(KEYS_TITLE)).toBeNull()
		expect(screen.queryByText(STORAGE_TITLE)).toBeNull()
	})
})
