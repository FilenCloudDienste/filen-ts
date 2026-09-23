// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// The Copy submenu's tree reads its root level through this query; an empty, loaded root is enough here.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
// The clipboard entry's shortcut badge, reduced to its action id (the registry isn't loaded here).
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})

import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { PhotosDropdownMenuContent } from "@/features/photos/components/itemMenu"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

const PHOTO = narrowItem({
	uuid: "photo-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "album-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: true,
	meta: { type: "decoded", data: { name: "beach.jpg", mime: "image/jpeg", modified: 0n, size: 1n, key: "key", version: 2 } }
} satisfies File) as PhotoItem

function renderMenu() {
	const onItemAction = vi.fn()

	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(PhotosDropdownMenuContent, { rootUuid: "root", item: PHOTO, onItemAction })
		)
	)

	return { onItemAction }
}

async function openCopySubmenu(): Promise<void> {
	const trigger = screen.getByRole("menuitem", { name: "Copy" })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowRight" })
		await Promise.resolve()
	})
}

function menuItemByText(text: string): HTMLElement {
	const found = screen.getAllByRole("menuitem").find(entry => entry.textContent === text)

	if (found === undefined) {
		throw new Error(`no menu item "${text}"`)
	}

	return found
}

beforeEach(() => {
	useDriveClipboardStore.getState().clear()
})

afterEach(() => {
	cleanup()
})

describe("photos item menu", () => {
	it("offers drive's Copy submenu, whose picker entry opens the copy dialog for the photo", async () => {
		const { onItemAction } = renderMenu()

		await openCopySubmenu()
		fireEvent.click(screen.getByRole("menuitem", { name: "Choose destination…" }))

		expect(onItemAction).toHaveBeenCalledExactlyOnceWith("copy", PHOTO)
	})

	it("puts the photo on the drive clipboard from the submenu's Copy entry", async () => {
		renderMenu()

		await openCopySubmenu()
		fireEvent.click(menuItemByText("Copy drive.copy"))

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items: [PHOTO] })
	})
})
