// @vitest-environment jsdom

// Sharing from the contact picker runs as an activity: a share of several items, or of a directory
// (its tree re-encrypts per contact), closes the picker at once and shows its progress in the toast; one
// file keeps the picker's spinner and toasts only its result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Contact, Dir, File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { shareItems, toast } = vi.hoisted(() => ({
	shareItems: vi.fn(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() })
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/lib/share/actions", () => ({ shareItems }))
vi.mock("@/features/contacts/queries/contacts", () => ({
	useContactsQuery: () => ({ status: "success", data: { contacts: CONTACTS, blocked: [] } })
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useActivityStore } from "@/lib/activity/activityStore"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"

function contact(label: string): Contact {
	return {
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		userId: 1n,
		email: `${label}@example.com`,
		nickName: undefined,
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "pk"
	}
}

const CONTACTS = [contact("alice"), contact("bob")]

function file(name: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

function dir(name: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

function open(items: DriveItem[], onClose = vi.fn()) {
	render(createElement(ContactPickerDialog, { items, onClose }))

	return onClose
}

function pick(email: string): void {
	fireEvent.click(screen.getByRole("option", { name: new RegExp(email) }))
}

function share(): void {
	fireEvent.click(screen.getByRole("button", { name: "Share" }))
}

beforeEach(() => {
	vi.clearAllMocks()
	useDriveStore.setState({ selectedItems: [] })
	useActivityStore.setState({ progress: {}, details: null })
})

afterEach(() => {
	cleanup()
})

describe("ContactPickerDialog sharing", () => {
	it("hands a directory's share to the toast at once, reporting its progress as a fraction", async () => {
		const shared = dir("Photos")
		let finish: (outcome: unknown) => void = () => undefined
		let progress: (fraction: number) => void = () => undefined
		shareItems.mockImplementation((_items: DriveItem[], _contacts: Contact[], onProgress: (fraction: number) => void) => {
			progress = onProgress

			return new Promise(resolve => {
				finish = resolve
			})
		})
		useDriveStore.setState({ selectedItems: [shared] })
		const onClose = open([shared])

		pick("alice@example.com")
		pick("bob@example.com")
		share()

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(toast).toHaveBeenCalledWith("Sharing Photos with 2 contacts", expect.objectContaining({ duration: Infinity }))

		progress(0.4)

		expect(Object.values(useActivityStore.getState().progress)).toEqual([{ kind: "fraction", value: 0.4 }])

		await act(async () => {
			finish({ succeeded: [shared], failed: [] })
			await Promise.resolve()
		})

		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Shared Photos with 2 contacts", expect.anything())
		expect(useDriveStore.getState().selectedItems).toEqual([])
		expect(useActivityStore.getState().progress).toEqual({})
	})

	it("hands several files to the toast at once", () => {
		shareItems.mockReturnValue(new Promise(() => undefined))
		const onClose = open([file("a.txt"), file("b.txt")])

		pick("alice@example.com")
		share()

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(toast).toHaveBeenCalledWith("Sharing 2 items with alice@example.com", expect.anything())
	})

	it("keeps the picker's spinner for one file, toasts only the result, and stays open on a failure", async () => {
		const only = file("a.txt")
		let finish: (outcome: unknown) => void = () => undefined
		shareItems.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		const onClose = open([only])

		pick("alice@example.com")
		share()

		expect(onClose).not.toHaveBeenCalled()
		expect(toast).not.toHaveBeenCalled()

		await act(async () => {
			finish({ succeeded: [], failed: [{ item: only, error: { species: "plain", message: "Not allowed", label: "Not allowed" } }] })
			await Promise.resolve()
		})

		// Still on the chosen contacts, to try again or change them.
		expect(onClose).not.toHaveBeenCalled()
		expect(toast.error).toHaveBeenCalledExactlyOnceWith(
			"Couldn't share a.txt with alice@example.com",
			expect.objectContaining({ description: "Not allowed" })
		)
	})
})
