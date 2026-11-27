// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement } from "react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import "@/lib/i18n"

// The selection bar: the selection's menu with Download, Share, Move, Copy, Favorite and Trash (Restore and Delete
// permanently in the trash) on its face, everything else in its More actions menu.

const { sdk, startDownloads } = vi.hoisted(() => ({
	sdk: {
		archiveNameInfo: vi.fn(() => Promise.resolve([])),
		archiveFormatInfo: vi.fn(() => Promise.resolve([])),
		archiveCodecMemBudget: vi.fn(() => Promise.resolve(0))
	},
	startDownloads: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/lib/download", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/download")>()),
	startDownloads
}))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))

import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { queryClient } from "@/queries/client"
import { BulkActionBar } from "@/features/drive/components/bulkActionBar"
import { mockDirItem, ownedFileItem } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

function file(name: string): DriveItem {
	return ownedFileItem(name, "application/pdf", { uuid: testUuid(name) })
}

function dir(name: string): DriveItem {
	return mockDirItem({ uuid: testUuid(name), meta: { type: "decoded", data: { name } } })
}

const onDialogAction = vi.fn()
const onOpen = vi.fn()

function renderBar(items: DriveItem[], variant: DriveVariant = "drive"): void {
	render(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(BulkActionBar, {
				variant,
				selectedItems: items,
				onDialogAction,
				onOpen,
				searchHit: () => false,
				destination: () => ({ actionsFor: vi.fn(), ancestry: [], pasteShortcut: false })
			})
		)
	)
}

function barButtons(): string[] {
	return within(screen.getByRole("toolbar"))
		.getAllByRole("button")
		.map(button => button.getAttribute("aria-label") ?? "")
}

async function openMore(): Promise<void> {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "More actions" }))
		await Promise.resolve()
	})
}

// Each entry's label, its key hint left out.
function menuLabels(): string[] {
	return screen.getAllByRole("menuitem").map(item => {
		const label = item.cloneNode(true) as HTMLElement

		label.querySelector("[data-slot=menu-shortcut]")?.remove()

		return label.textContent.trim()
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	queryClient.clear()
})

afterEach(() => {
	cleanup()
	onlineManager.setOnline(true)
})

describe("BulkActionBar — pinned and overflow", () => {
	it("one file: the pinned actions on the face, the single-item rest under More actions", async () => {
		renderBar([file("report.pdf")])

		expect(barButtons()).toEqual([
			"Clear selection",
			"Move",
			"Copy",
			"Favorite",
			"Download",
			"Share",
			"Trash",
			"More actions",
			"Details"
		])

		await openMore()

		expect(menuLabels()).toEqual(["Open", "Rename", "Compress", "Versions", "Info", "Copy ID", "Public link"])
	})

	it("one directory: Open, its New and Paste entries and Color in the overflow", async () => {
		renderBar([dir("Documents")])
		await openMore()

		const labels = menuLabels()

		expect(labels[0]).toBe("Open")
		expect(labels).toContain("Color")
		expect(labels).toContain("Rename")
	})

	it("several items: no single-item entries, and Color for directories only", async () => {
		renderBar([dir("a"), dir("b")])
		await openMore()

		expect(menuLabels()).toEqual(["Compress", "Color"])

		cleanup()
		renderBar([file("a.pdf"), dir("b")])
		await openMore()

		expect(menuLabels()).toEqual(["Compress"])
	})

	it("the trash: Restore and Delete permanently, nothing to overflow for several", () => {
		renderBar([file("a.pdf"), file("b.pdf")], "trash")

		expect(barButtons()).toEqual(["Clear selection", "Restore", "Delete permanently", "Details"])
	})

	it("Links: no Move, Disable link sits in the overflow", async () => {
		renderBar([file("a.pdf"), file("b.pdf")], "links")

		expect(barButtons()).not.toContain("Move")

		await openMore()

		expect(menuLabels()).toEqual(["Compress", "Disable public link"])
	})

	it("runs a pinned action on the selection and a dialog entry through the host", () => {
		const items = [file("a.pdf"), file("b.pdf")]

		renderBar(items)
		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		fireEvent.click(screen.getByRole("button", { name: "Trash" }))

		expect(startDownloads).toHaveBeenCalledExactlyOnceWith(items)
		expect(onDialogAction).toHaveBeenCalledExactlyOnceWith("trash", items)
	})

	it("Move opens its transfer menu: the clipboard entry and the destination picker", async () => {
		const items = [file("a.pdf")]

		renderBar(items)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Move" }))
			await Promise.resolve()
		})

		expect(menuLabels().slice(0, 2)).toEqual(["Cut", "Choose destination…"])

		fireEvent.click(screen.getByRole("menuitem", { name: /^Choose destination…/ }))

		expect(onDialogAction).toHaveBeenCalledExactlyOnceWith("move", items, undefined)
	})

	it("offline, the network actions are disabled and say why; Move still opens for its clipboard entry", () => {
		onlineManager.setOnline(false)
		renderBar([file("a.pdf"), file("b.pdf")])

		const trash = screen.getByRole("button", { name: "Trash" })

		expect(trash.getAttribute("aria-disabled")).toBe("true")
		expect(trash).toHaveProperty("textContent", expect.stringContaining("Unavailable while offline"))
		expect(screen.getByRole("button", { name: "Move" }).getAttribute("aria-disabled")).not.toBe("true")
	})
})
