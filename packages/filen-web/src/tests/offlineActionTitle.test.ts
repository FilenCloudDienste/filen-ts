// @vitest-environment jsdom

// Proves the offline gating sweep's own "tooltip/label" half actually renders — every gated control
// disables itself while offline (covered separately by each surface's own logic tests: itemMenu.logic.ts's
// applyOfflineGate, bulkActionBar.logic.ts's isBulkActionOfflineDisabled, composer.logic.ts's
// isAttachDisabled, accountPreferences.logic.ts's isPreferenceRowDisabled, eventsPagination.ts's
// shouldSkipEventsScroll), but none of those prove the disabled control tells the user WHY. This
// renders one representative control per surface family (drive/contacts/settings) and asserts the
// shared "common:offlineActionDisabled" copy shows up as its native title exactly while offline, and
// is absent once back online.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import "@/lib/i18n"
import { onlineManager } from "@tanstack/react-query"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { EmptyTrashButton } from "@/features/drive/components/emptyTrashButton"
import { AddContactDialog } from "@/features/contacts/components/addContactDialog"
import { GdprExportCard } from "@/features/settings/components/account/gdprExportCard"

const OFFLINE_TITLE = "Unavailable while offline"

afterEach(() => {
	cleanup()
	onlineManager.setOnline(true)
})

describe("offline-disabled controls surface a title explaining why", () => {
	it("EmptyTrashButton (drive): carries the offline title exactly when its caller marks it offline-disabled", () => {
		const { getByRole, rerender } = render(
			createElement(EmptyTrashButton, { onClick: vi.fn(), disabled: false, offlineTitle: undefined })
		)
		expect(getByRole("button").getAttribute("title")).toBeNull()

		rerender(createElement(EmptyTrashButton, { onClick: vi.fn(), disabled: true, offlineTitle: OFFLINE_TITLE }))
		expect(getByRole("button").getAttribute("title")).toBe(OFFLINE_TITLE)
	})

	it("AddContactDialog (contacts): the trigger button's title reflects live online/offline state", () => {
		onlineManager.setOnline(true)
		const { getByRole } = render(createElement(AddContactDialog))

		expect(getByRole("button", { name: "Add contact" }).getAttribute("title")).toBeNull()

		cleanup()
		onlineManager.setOnline(false)
		const { getByRole: getByRoleOffline } = render(createElement(AddContactDialog))

		expect(getByRoleOffline("button", { name: "Add contact" }).getAttribute("title")).toBe(OFFLINE_TITLE)
	})

	it("GdprExportCard (settings mutation): the export button's title reflects live online/offline state", () => {
		onlineManager.setOnline(true)
		const { getByRole } = render(createElement(GdprExportCard))

		expect(getByRole("button", { name: "Export data" }).getAttribute("title")).toBeNull()

		cleanup()
		onlineManager.setOnline(false)
		const { getByRole: getByRoleOffline } = render(createElement(GdprExportCard))

		expect(getByRoleOffline("button", { name: "Export data" }).getAttribute("title")).toBe(OFFLINE_TITLE)
	})
})
