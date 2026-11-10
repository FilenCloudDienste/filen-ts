// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactElement, ReactNode } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// Key hints at a menu item's end (MenuShortcut, MenuKbd) and in a labelled control's tooltip (KeyTooltip): the drive,
// photos and preview item menus show each entry's key on the surface it was opened on, the bulk menu the selection's,
// and the zoom menu its fits'. Off a Mac (jsdom's user agent).

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("@/lib/storage/adapter", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/storage/adapter")>()),
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
vi.mock("@tanstack/react-router", async importOriginal => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => vi.fn()
}))
// The tooltip's parts, flattened: its content renders in place, so a test reads what it would show.
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: (props: { children: ReactNode }) => props.children,
	TooltipTrigger: (props: { render: ReactElement }) => props.render,
	TooltipContent: (props: { children: ReactNode }) => <div data-testid="tooltip">{props.children}</div>
}))

const { registerAllActions, ALL_ACTIONS } = await import("@/lib/keymap/actions")
const { clearUserCombo, setUserCombo, unbindAction } = await import("@/lib/keymap/registry")
const { narrowItem } = await import("@/features/drive/lib/item")
const { DriveDropdownMenuContent } = await import("@/features/drive/components/itemMenu")
const { DRIVE_ITEM_SHORTCUTS, itemMenuShortcut } = await import("@/features/drive/components/itemMenu.logic")
const { driveBulkKbdAction } = await import("@/features/drive/components/bulkActionBar.logic")
const { PHOTOS_ITEM_SHORTCUTS } = await import("@/features/photos/lib/itemActions")
const { PREVIEW_ITEM_SHORTCUTS } = await import("@/features/preview/components/previewOverlay.logic")
const { ZoomMenuContent } = await import("@/features/preview/components/commandBarControls")
const { DropdownMenu, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu")
const { MenuShortcut } = await import("@/components/ui/menuShortcut")
const { KeyTooltip, MenuKbd } = await import("@/lib/keymap/kbdHints")

registerAllActions()

function report(): ReturnType<typeof narrowItem> {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000" as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "report.pdf", mime: "application/pdf", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

// Each menu entry's label (its own text, the hint left out) and the keys its hint shows ("" without one).
function entries(): [string, string][] {
	return screen.getAllByRole("menuitem").map(entry => {
		const label = entry.cloneNode(true) as HTMLElement
		const hint = label.querySelector("[data-slot=menu-shortcut]")
		const keys = [...(hint?.querySelectorAll("[data-slot=kbd]") ?? [])].map(key => key.textContent).join(" ")

		hint?.remove()

		return [label.textContent.trim(), keys]
	})
}

function keysOf(label: string): string | undefined {
	return entries().find(([entry]) => entry === label)?.[1]
}

function openItemMenu(variant: "drive" | "trash" | "links", shortcuts = DRIVE_ITEM_SHORTCUTS): void {
	render(
		<DropdownMenu defaultOpen>
			<DropdownMenuTrigger>menu</DropdownMenuTrigger>
			<DriveDropdownMenuContent
				item={report()}
				variant={variant}
				onItemAction={vi.fn()}
				onOpen={vi.fn()}
				shortcuts={shortcuts}
			/>
		</DropdownMenu>
	)
}

afterEach(async () => {
	cleanup()
	await Promise.all(["drive.rename", "drive.info", "transfers.clearFinished"].map(clearUserCombo))
})

describe("the item menus' key hints", () => {
	it("name only registered actions", () => {
		const registered = new Set(ALL_ACTIONS.map(def => def.id))
		const named = [
			...[DRIVE_ITEM_SHORTCUTS, PHOTOS_ITEM_SHORTCUTS, PREVIEW_ITEM_SHORTCUTS].flatMap(shortcuts => [
				...Object.values(shortcuts.entries),
				shortcuts.copyToClipboard,
				shortcuts.deleteKey
			]),
			...(
				["favorite", "move", "copy", "compress", "extract", "share", "download", "downloadAs", "restoreSelected", "delete"] as const
			).map(id => driveBulkKbdAction(id, null))
		].filter(id => id !== undefined)

		expect(named.filter(id => !registered.has(id))).toEqual([])
	})

	it("puts the Delete key on the removal it runs, after an entry's own key", () => {
		expect(itemMenuShortcut(DRIVE_ITEM_SHORTCUTS, "rename", "trash")).toBe("drive.rename")
		expect(itemMenuShortcut(DRIVE_ITEM_SHORTCUTS, "trash", "trash")).toBe("drive.trash")
		expect(itemMenuShortcut(DRIVE_ITEM_SHORTCUTS, "unshare", "unshare")).toBe("drive.trash")
		expect(itemMenuShortcut(DRIVE_ITEM_SHORTCUTS, "trash", "unshare")).toBeUndefined()
		expect(itemMenuShortcut(DRIVE_ITEM_SHORTCUTS, "publicLink", null)).toBeUndefined()
		expect(itemMenuShortcut(undefined, "rename", null)).toBeUndefined()
		expect(itemMenuShortcut(PREVIEW_ITEM_SHORTCUTS, "trash", null)).toBe("preview.trash")
		expect(driveBulkKbdAction("trash", "trash")).toBe("drive.trash")
		expect(driveBulkKbdAction("unshare", "unshare")).toBe("drive.trash")
		expect(driveBulkKbdAction("trash", "unshare")).toBeUndefined()
	})

	it("shows the drive listing's keys at the entries' ends, an unbound one showing nothing", () => {
		openItemMenu("drive")

		expect(keysOf("Open")).toBe("↵")
		expect(keysOf("Rename")).toBe("F2")
		expect(keysOf("Trash")).toBe("Del ⌫")
		// Unbound by default: its slot is empty, and so hidden.
		expect(keysOf("Public link")).toBe("")
	})

	it("follows the user's bindings", async () => {
		await setUserCombo("drive.rename", "mod+shift+r")
		await unbindAction("drive.info")
		openItemMenu("drive")

		expect(keysOf("Rename")).toBe("Ctrl Shift R")
		expect(keysOf("Info")).toBe("")
	})

	it("gives the trash its own keys, and no Delete hint where Delete does something else (a link is disabled)", () => {
		openItemMenu("trash")
		expect(keysOf("Restore")).toBe("R")
		cleanup()

		openItemMenu("links")
		expect(keysOf("Trash")).toBe("")
	})

	it("shows nothing on a surface without keys of its own", () => {
		render(
			<DropdownMenu defaultOpen>
				<DropdownMenuTrigger>menu</DropdownMenuTrigger>
				<DriveDropdownMenuContent
					item={report()}
					variant="drive"
					onItemAction={vi.fn()}
				/>
			</DropdownMenu>
		)

		expect(entries().every(([, keys]) => keys === "")).toBe(true)
	})

	it("shows the photos grid's keys in a photo's menu", () => {
		openItemMenu("drive", PHOTOS_ITEM_SHORTCUTS)

		expect(keysOf("Rename")).toBe("F2")
		expect(keysOf("Trash")).toBe("Del ⌫")
		expect(keysOf("Open")).toBe("")
	})
})

describe("the zoom menu's fits", () => {
	it("show the keys the viewer gives them", () => {
		render(
			<DropdownMenu defaultOpen>
				<DropdownMenuTrigger>zoom</DropdownMenuTrigger>
				<ZoomMenuContent
					percent={100}
					presets={[50, 100]}
					fits={["fitWidth", "fitPage"]}
					mode="custom"
					fitShortcuts={{ fitWidth: "preview.pdfFitWidth" }}
					onPercent={vi.fn()}
					onFit={vi.fn()}
				/>
			</DropdownMenu>
		)

		const hints = screen.getAllByRole("menuitemradio").map(entry => entry.querySelector("[data-slot=menu-shortcut]") !== null)

		// 50 %, 100 %, Fit width (its key), Fit page (none given).
		expect(hints).toEqual([false, false, true, false])
	})
})

describe("<MenuShortcut>, <MenuKbd> and <KeyTooltip>", () => {
	it("collapse to nothing for an unbound action", () => {
		const { container } = render(
			<>
				<MenuShortcut>{null}</MenuShortcut>
				<MenuKbd action="transfers.clearFinished" />
				<MenuKbd action={undefined} />
			</>
		)
		const slots = container.querySelectorAll("[data-slot=menu-shortcut]")

		expect(slots.length).toBe(2)
		expect([...slots].every(slot => slot.childElementCount === 0 && slot.className.includes("empty:hidden"))).toBe(true)
	})

	it("add a tooltip naming a labelled control's keys only while it has keys", async () => {
		const control = (
			<KeyTooltip
				action="transfers.clearFinished"
				label="Clear finished"
			>
				<button type="button">Clear finished</button>
			</KeyTooltip>
		)
		const view = render(control)

		expect(screen.queryByTestId("tooltip")).toBeNull()
		expect(screen.getByRole("button", { name: "Clear finished" })).toBeDefined()

		await act(async () => {
			await setUserCombo("transfers.clearFinished", "alt+shift+k")
		})
		view.rerender(control)

		const tooltip = screen.getByTestId("tooltip")

		expect(tooltip.textContent).toContain("Clear finished")
		expect([...tooltip.querySelectorAll("[data-slot=kbd]")].map(key => key.textContent)).toEqual(["Alt", "Shift", "K"])
	})
})
