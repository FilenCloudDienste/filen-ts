// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react"
import { createElement } from "react"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// The row/tile pull the SDK surface in transitively (item menu -> actions); a Vite `?worker` import is
// unresolvable under vitest and no case here reaches a worker op. The thumbnail + drop hooks are
// stubbed for the same reason: neither is what these assertions are about.
// The clipboard entries' shortcut badge, reduced to its action id (the registry isn't loaded here).
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
// The Move submenu's tree levels read through this hook once opened; left loading here, since the tree
// itself is covered by directoryTreeSubmenu.test.ts.
vi.mock("@/features/drive/queries/drive", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/queries/drive")>()
	return { ...actual, useDirectoryTreeChildrenQuery: () => ({ status: "pending" }) }
})
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/hooks/useDriveDropTarget", () => ({
	useDriveDropTarget: () => ({
		isOver: false,
		onDragEnter: () => undefined,
		onDragOver: () => undefined,
		onDragLeave: () => undefined,
		onDrop: () => undefined
	})
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { DriveRow, type DriveRowProps } from "@/features/drive/components/driveRow"
import { DriveTile } from "@/features/drive/components/driveTile"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(label: string): DriveItem {
	const dir: Dir = {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}

	return narrowItem(dir)
}

const ROW_INDEX = 4

function sharedProps(
	item: DriveItem,
	selected: boolean,
	onCursorMove: (index: number) => void,
	handlers: Partial<Pick<DriveRowProps, "onItemAction" | "onBulkAction">> = {}
) {
	return {
		item,
		index: ROW_INDEX,
		total: 9,
		selected,
		active: false,
		variant: "drive" as const,
		splat: "",
		selectedItems: selected ? [item, dirItem("other")] : [],
		onPointerSelect: () => undefined,
		onCursorMove,
		onOpen: () => undefined,
		onItemAction: () => undefined,
		onBulkAction: () => undefined,
		registerRef: () => undefined,
		...handlers
	}
}

function renderRow(item: DriveItem, selected: boolean, onCursorMove: (index: number) => void) {
	return render(createElement(DriveRow, { ...sharedProps(item, selected, onCursorMove), style: {}, directorySizes: new Map() }))
}

function renderTile(item: DriveItem, selected: boolean, onCursorMove: (index: number) => void) {
	return render(createElement(DriveTile, sharedProps(item, selected, onCursorMove)))
}

function rightClick(container: HTMLElement): void {
	const row = container.querySelector('[role="option"]')

	if (!row) {
		throw new Error("no option row rendered")
	}

	fireEvent.contextMenu(row)
}

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [] })
	useDriveClipboardStore.getState().clear()
})

afterEach(() => {
	cleanup()
})

describe("right-click retarget", () => {
	it("a row retargets the selection AND the roving cursor/anchor", () => {
		const item = dirItem("target")
		const onCursorMove = vi.fn()
		const { container } = renderRow(item, false, onCursorMove)

		rightClick(container)

		expect(useDriveStore.getState().selectedItems).toEqual([item])
		expect(onCursorMove).toHaveBeenCalledExactlyOnceWith(ROW_INDEX)
	})

	it("a tile retargets both the same way", () => {
		const item = dirItem("target")
		const onCursorMove = vi.fn()
		const { container } = renderTile(item, false, onCursorMove)

		rightClick(container)

		expect(useDriveStore.getState().selectedItems).toEqual([item])
		expect(onCursorMove).toHaveBeenCalledExactlyOnceWith(ROW_INDEX)
	})

	it("leaves an already-selected row's selection and cursor alone (the bulk menu opens over the whole selection)", () => {
		const item = dirItem("target")
		const onCursorMove = vi.fn()
		const { container } = renderRow(item, true, onCursorMove)

		rightClick(container)

		expect(useDriveStore.getState().selectedItems).toEqual([])
		expect(onCursorMove).not.toHaveBeenCalled()
	})
})

describe("Move submenu", () => {
	async function openMove(): Promise<HTMLElement> {
		const move = screen.getByRole("menuitem", { name: "Move" })

		await act(async () => {
			move.focus()
			fireEvent.keyDown(move, { key: "ArrowRight" })
			await Promise.resolve()
		})

		return move
	}

	it("the single-item menu offers Move as a submenu whose picker entry opens the move dialog for the item", async () => {
		const item = dirItem("target")
		const onItemAction = vi.fn()
		const { container } = render(
			createElement(DriveRow, {
				...sharedProps(item, false, () => undefined, { onItemAction }),
				style: {},
				directorySizes: new Map()
			})
		)

		rightClick(container)
		const move = await openMove()
		expect(move.getAttribute("aria-haspopup")).toBe("menu")

		fireEvent.click(screen.getByRole("menuitem", { name: "Choose destination…" }))
		expect(onItemAction).toHaveBeenCalledExactlyOnceWith("move", item)
	})

	it("the bulk menu offers the same submenu, its picker entry dispatching the bulk move", async () => {
		const item = dirItem("target")
		const onBulkAction = vi.fn()
		const { container } = render(
			createElement(DriveRow, {
				...sharedProps(item, true, () => undefined, { onBulkAction }),
				style: {},
				directorySizes: new Map()
			})
		)

		rightClick(container)
		const move = await openMove()
		expect(move.getAttribute("aria-haspopup")).toBe("menu")

		fireEvent.click(screen.getByRole("menuitem", { name: "Choose destination…" }))
		expect(onBulkAction).toHaveBeenCalledExactlyOnceWith("move")
	})

	// The ⋯ dropdown is mounted inside the row (unlike the context menu, a sibling of its trigger), so its
	// portaled popups' clicks bubble through the React tree into the row's own handlers.
	it("clicks and double-clicks inside the ⋯ dropdown's submenu never reach the row's own handlers", async () => {
		const item = dirItem("target")
		const onPointerSelect = vi.fn()
		const onOpen = vi.fn()
		render(
			createElement(DriveRow, {
				...sharedProps(item, false, () => undefined),
				onPointerSelect,
				onOpen,
				style: {},
				directorySizes: new Map()
			})
		)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "More actions" }))
			await Promise.resolve()
		})
		const move = await openMove()
		fireEvent.click(move)
		fireEvent.doubleClick(move)
		fireEvent.click(screen.getByText("Cloud Drive"))
		fireEvent.doubleClick(screen.getByText("Cloud Drive"))

		expect(onPointerSelect).not.toHaveBeenCalled()
		expect(onOpen).not.toHaveBeenCalled()
	})
})

describe("cut dimming", () => {
	function isDimmed(container: HTMLElement): boolean {
		return container.querySelector('[role="option"]')?.hasAttribute("data-cut") ?? false
	}

	it("dims a cut row and tile until the clipboard changes, and never a copied one", () => {
		const item = dirItem("target")
		const other = dirItem("other")
		const row = renderRow(item, false, () => undefined)
		const tile = renderTile(item, false, () => undefined)

		expect(isDimmed(row.container)).toBe(false)

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "cut", items: [item] })
		})

		expect(isDimmed(row.container)).toBe(true)
		expect(isDimmed(tile.container)).toBe(true)

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "cut", items: [other] })
		})

		expect(isDimmed(row.container)).toBe(false)

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "copy", items: [item] })
		})

		expect(isDimmed(row.container)).toBe(false)
		expect(isDimmed(tile.container)).toBe(false)
	})
})
