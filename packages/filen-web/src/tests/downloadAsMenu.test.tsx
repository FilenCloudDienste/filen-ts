// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// Download as in the item and bulk menus as a screen reader and a keyboard meet it: a named submenu trigger that
// says it opens a menu, a named format entry, ArrowRight to open; disabled offline; and the password prompt a
// protected file asks, a named dialog that names the file.

const { start, online } = vi.hoisted(() => ({ start: vi.fn(), online: { current: true } }))

vi.mock("@/features/drive/lib/downloadAs", () => ({ startDownloadAs: start }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { queryClient } from "@/queries/client"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DriveContextMenuContent } from "@/features/drive/components/itemMenu"
import { DownloadAsPasswordDialog } from "@/features/drive/components/downloadAsPasswordDialog"
import { askPassword } from "@/features/drive/lib/downloadAsPassword"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"

function file(name: string, uuid: UuidStr = "33333333-3333-3333-3333-333333333333"): DriveItem {
	return narrowItem({
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

function renderItemMenu(item: DriveItem): void {
	render(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(
				DropdownMenu,
				{ defaultOpen: true },
				createElement(DropdownMenuTrigger, null, "menu"),
				createElement(DriveDropdownMenuContent, { items: [item], variant: "drive", onDialogAction: vi.fn() })
			)
		)
	)
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

// Base UI opens a submenu on ArrowRight — the keyboard path, free of hover timers.
async function openDownloadAs(): Promise<HTMLElement> {
	const trigger = screen.getByRole("menuitem", { name: "Download as" })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowRight" })
		await settle()
	})

	return trigger
}

beforeEach(() => {
	online.current = true
	queryClient.clear()
})

afterEach(() => {
	cleanup()
})

describe("Download as in the item menu", () => {
	it("is a named submenu trigger that says it opens a menu, and its PDF entry starts the export of that file", async () => {
		const item = file("report.docx")

		renderItemMenu(item)

		const trigger = await openDownloadAs()

		expect(trigger.getAttribute("aria-haspopup")).toBe("menu")
		expect(trigger.getAttribute("aria-expanded")).toBe("true")

		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "PDF document (.pdf)" }))
		})

		expect(start).toHaveBeenCalledWith([item], "pdf", { accessMode: "authed", cacheScope: "authed" })
	})

	it("offers the formats the file converts to after the PDF, never its own, and starts that conversion", async () => {
		const item = file("notes.odt")

		renderItemMenu(item)
		await openDownloadAs()

		expect(screen.queryByRole("menuitem", { name: "OpenDocument text (.odt)" })).toBeNull()

		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Word document (.docx)" }))
		})

		expect(start).toHaveBeenCalledWith([item], "docx", { accessMode: "authed", cacheScope: "authed" })
	})

	it("is offered for a spreadsheet and not for a file it cannot export", () => {
		renderItemMenu(file("book.ods"))
		expect(screen.getByRole("menuitem", { name: "Download as" })).toBeTruthy()
		cleanup()

		renderItemMenu(file("photo.jpg"))
		expect(screen.queryByRole("menuitem", { name: "Download as" })).toBeNull()
	})

	it("is disabled offline, saying why", () => {
		online.current = false
		renderItemMenu(file("report.docx"))

		const trigger = screen.getByRole("menuitem", { name: "Download as" })

		expect(trigger.getAttribute("aria-disabled")).toBe("true")
		expect(trigger.getAttribute("title")).toBeTruthy()
	})
})

describe("Download as in the bulk context menu", () => {
	it("exports the whole selection when every file can be exported", async () => {
		const items = [file("a.docx", "11111111-1111-1111-1111-111111111111"), file("b.xlsx")]

		render(
			createElement(
				ContextMenu,
				{ defaultOpen: true },
				createElement(ContextMenuTrigger, null, "rows"),
				createElement(DriveContextMenuContent, { variant: "drive", items, onDialogAction: vi.fn() })
			)
		)
		await openDownloadAs()

		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "PDF document (.pdf)" }))
		})

		expect(start).toHaveBeenCalledWith(items, "pdf", { accessMode: "authed", cacheScope: "authed" })
	})
})

describe("Download as password prompt", () => {
	it("is a named dialog naming the file, with a labelled password field; Cancel lets the export skip the file", async () => {
		render(createElement(DownloadAsPasswordDialog))

		const controller = new AbortController()
		let asked: Promise<boolean> | undefined

		await act(async () => {
			asked = askPassword("secret.docx", () => Promise.resolve("wrong"), controller.signal)
			await settle()
		})

		const dialog = screen.getByRole("dialog", { name: "Protect the PDF" })

		expect(dialog.textContent).toContain("secret.docx")
		expect(screen.getByLabelText("Document password")).toBeTruthy()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
			await settle()
		})

		expect(await asked).toBe(false)
	})
})
