// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { toggleFavorite, restoreItems, toast } = vi.hoisted(() => ({
	toggleFavorite: vi.fn(),
	restoreItems: vi.fn(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() })
}))

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	toggleFavorite,
	restoreItems
}))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { DriveDropdownMenuContent, type ItemMenuContentProps } from "@/features/drive/components/itemMenu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

function report(favorited: boolean): DriveItem {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000" as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "report.pdf", mime: "application/pdf", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

const ERROR = { species: "plain", message: "Not allowed", label: "Not allowed" }

async function choose(label: string, item: DriveItem, variant: DriveVariant, props: Partial<ItemMenuContentProps> = {}): Promise<void> {
	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(DriveDropdownMenuContent, { item, variant, onItemAction: vi.fn(), ...props })
		)
	)

	await act(async () => {
		fireEvent.click(screen.getByRole("menuitem", { name: label }))

		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	useDriveStore.setState({ selectedItems: [] })
})

afterEach(() => {
	cleanup()
})

describe("item menu Favorite", () => {
	it("runs as an activity and hands the favorited item on", async () => {
		const favorited = report(true)
		const onFavoriteToggled = vi.fn()
		toggleFavorite.mockResolvedValueOnce({ status: "success", item: favorited })

		await choose("Favorite", report(false), "drive", { onFavoriteToggled })

		expect(toast).toHaveBeenCalledWith("Adding report.pdf to favorites", expect.anything())
		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Added report.pdf to favorites", expect.anything())
		expect(onFavoriteToggled).toHaveBeenCalledExactlyOnceWith(favorited)
	})

	it("says why unfavoriting failed, offering to try again", async () => {
		const onFavoriteToggled = vi.fn()
		toggleFavorite.mockResolvedValueOnce({ status: "error", dto: ERROR })

		await choose("Unfavorite", report(true), "favorites", { onFavoriteToggled })

		expect(toast).toHaveBeenCalledWith("Removing report.pdf from favorites", expect.anything())
		expect(toast.error).toHaveBeenCalledExactlyOnceWith(
			"Couldn't remove report.pdf from favorites",
			expect.objectContaining({ description: "Not allowed" })
		)
		expect(toast.error.mock.lastCall?.[1]).toHaveProperty("action.label", "Try again")
		expect(onFavoriteToggled).not.toHaveBeenCalled()
	})

	it("drops an unfavorited item from the favorites selection", async () => {
		const item = report(true)
		useDriveStore.setState({ selectedItems: [item] })
		toggleFavorite.mockResolvedValueOnce({ status: "success", item: report(false) })

		await choose("Unfavorite", item, "favorites")

		expect(useDriveStore.getState().selectedItems).toEqual([])
	})
})

describe("item menu Restore", () => {
	it("runs as an activity, pruning the restored item and telling the surface", async () => {
		const item = report(false)
		const onRestored = vi.fn()
		useDriveStore.setState({ selectedItems: [item] })
		restoreItems.mockResolvedValueOnce({ succeeded: [item], failed: [] })

		await choose("Restore", item, "trash", { onRestored })

		expect(restoreItems).toHaveBeenCalledExactlyOnceWith([item], expect.any(Function), expect.any(Function))
		expect(toast).toHaveBeenCalledWith("Restoring report.pdf", expect.anything())
		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Restored report.pdf", expect.anything())
		expect(onRestored).toHaveBeenCalledExactlyOnceWith(item)
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("keeps a failed restore selected and the surface untold", async () => {
		const item = report(false)
		const onRestored = vi.fn()
		useDriveStore.setState({ selectedItems: [item] })
		restoreItems.mockResolvedValueOnce({ succeeded: [], failed: [{ item, error: ERROR }] })

		await choose("Restore", item, "trash", { onRestored })

		expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't restore report.pdf", expect.anything())
		expect(onRestored).not.toHaveBeenCalled()
		expect(useDriveStore.getState().selectedItems).toEqual([item])
	})
})
