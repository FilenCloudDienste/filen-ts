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
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { Contact, File, FileVersion } from "@filen/sdk-rs"
import "@/lib/i18n"
import { onlineManager } from "@tanstack/react-query"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Both dialogs below read their data through a bare useQuery with no provider in this suite's tree,
// so each is overridden at its own HOOK boundary rather than by standing up a QueryClientProvider
// this file has never needed. importOriginal keeps every other export of those modules genuine —
// versionsDialog.tsx and drive's action helpers pull several more from the drive queries module.
const { pickerContact, versionedFile, olderVersion } = vi.hoisted(() => {
	const contact = {
		uuid: "11111111-1111-1111-1111-111111111111",
		userId: 1n,
		email: "alice@filen.io",
		nickName: "Alice",
		lastActive: 1_700_000_000_000n,
		timestamp: 1_700_000_000_000n,
		publicKey: "alice-public-key"
	} as Contact

	const file = {
		uuid: "22222222-2222-2222-2222-222222222222",
		parent: "33333333-3333-3333-3333-333333333333",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	} as File

	// ONE non-current version: a second row would render another Restore/Delete pair and make the
	// aria-label queries below ambiguous.
	const version = {
		uuid: "44444444-4444-4444-4444-444444444444",
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 1_600_000_000_000n,
		size: 512n,
		metadata: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_600_000_000_000n, size: 512n, key: "key", version: 2 }
		}
	} as FileVersion

	return { pickerContact: contact, versionedFile: file, olderVersion: version }
})

vi.mock("@/features/contacts/queries/contacts", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/contacts/queries/contacts")>()
	return { ...actual, useContactsQuery: () => ({ status: "success", data: { contacts: [pickerContact], blocked: [] } }) }
})

vi.mock("@/features/drive/queries/drive", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/queries/drive")>()
	return { ...actual, useFileVersionsQuery: () => ({ status: "success", data: [olderVersion] }) }
})

import { EmptyTrashButton } from "@/features/drive/components/emptyTrashButton"
import { AddContactDialog } from "@/features/contacts/components/addContactDialog"
import { GdprExportCard } from "@/features/settings/components/account/gdprExportCard"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { narrowItem } from "@/features/drive/lib/item"
import { type FileItem } from "@/features/drive/lib/actions"

const OFFLINE_TITLE = "Unavailable while offline"

function versionedFileItem(): FileItem {
	const item = narrowItem(versionedFile)

	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

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

	// Dialog content is portaled to document.body, so these query through `screen`, not the render
	// container.
	it("ContactPickerDialog (drive dialog confirm): the Share submit disables and explains itself while offline", () => {
		const item = versionedFileItem()

		onlineManager.setOnline(true)
		render(createElement(ContactPickerDialog, { items: [item], onClose: vi.fn() }))
		// canSubmit also requires a picked contact — select one first, or the online arm would be
		// disabled for an unrelated reason.
		fireEvent.click(screen.getByRole("option"))

		const online = screen.getByRole("button", { name: "Share" })
		expect(online.hasAttribute("disabled")).toBe(false)
		expect(online.getAttribute("title")).toBeNull()

		cleanup()
		onlineManager.setOnline(false)
		render(createElement(ContactPickerDialog, { items: [item], onClose: vi.fn() }))
		fireEvent.click(screen.getByRole("option"))

		const offline = screen.getByRole("button", { name: "Share" })
		expect(offline.hasAttribute("disabled")).toBe(true)
		expect(offline.getAttribute("title")).toBe(OFFLINE_TITLE)
	})

	it("VersionsDialog (drive dialog writes): every rendered write trigger disables and explains itself while offline", () => {
		const file = versionedFileItem()
		const triggerNames = ["Restore this version", "Delete this version", "Delete all"]

		onlineManager.setOnline(true)
		render(createElement(VersionsDialog, { file, onClose: vi.fn() }))

		for (const name of triggerNames) {
			const button = screen.getByRole("button", { name })
			expect(button.hasAttribute("disabled")).toBe(false)
			expect(button.getAttribute("title")).toBeNull()
		}

		cleanup()
		onlineManager.setOnline(false)
		render(createElement(VersionsDialog, { file, onClose: vi.fn() }))

		for (const name of triggerNames) {
			const button = screen.getByRole("button", { name })
			expect(button.hasAttribute("disabled")).toBe(true)
			expect(button.getAttribute("title")).toBe(OFFLINE_TITLE)
		}
	})
})
