// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { onlineManager } from "@tanstack/react-query"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// The tree reads each level through useDirectoryTreeChildrenQuery; the per-uuid results below stand in
// for it, and the move gates read full listings from the (mocked) query client, seeded per test.
const { treeResults, performMoveMock, startCopyWithCardMock } = vi.hoisted(() => ({
	treeResults: new Map<string, unknown>(),
	performMoveMock: vi.fn(),
	startCopyWithCardMock: vi.fn()
}))

// The clipboard entries' shortcut badge, reduced to its action id (the registry isn't loaded here).
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: performMoveMock }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: startCopyWithCardMock }))
vi.mock("@/features/drive/queries/drive", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/queries/drive")>()
	return {
		...actual,
		useDirectoryTreeChildrenQuery: (uuid: string | null) => treeResults.get(uuid ?? "root") ?? { status: "pending" }
	}
})

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryKey, projectTreeChildren } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"
import { DROPDOWN_TREE_MENU_FAMILY, DirectoryTreeSubmenu, type DirectoryTreeTarget } from "@/features/drive/components/directoryTreeSubmenu"
import { MoveSubmenu } from "@/features/drive/components/moveSubmenu"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { CopySubmenu } from "@/features/drive/components/copySubmenu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FolderInputIcon } from "lucide-react"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(label: string, parent: string, overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		parent: testUuid(parent),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } },
		...overrides
	} satisfies Dir)
}

function fileItem(label: string, parent: string): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid(parent),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: `${label}.txt`, mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	} satisfies File)
}

// Root holds "docs" (which holds "invoices") and "photos"; "report" is a file sitting in docs.
const DOCS = dirItem("docs", "root")
const PHOTOS = dirItem("photos", "root")
const INVOICES = dirItem("invoices", "docs")
const REPORT = fileItem("report", "docs")

// Seeds one level: the full listing into the query cache (what the gates read) and its directory
// projection into the stubbed tree hook (what the level renders).
function seedLevel(uuid: string | null, listing: DriveItem[]): void {
	queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid }), listing)
	treeResults.set(uuid ?? "root", { status: "success", data: projectTreeChildren(listing) })
}

function seedTree(): void {
	seedLevel(null, [DOCS, PHOTOS])
	seedLevel(DOCS.data.uuid, [INVOICES, REPORT])
	seedLevel(PHOTOS.data.uuid, [])
	seedLevel(INVOICES.data.uuid, [])
}

function inOpenMenu(children: ReactNode) {
	return render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(DropdownMenuContent, null, children)
		)
	)
}

// Base UI opens a submenu trigger on ArrowRight (list navigation) — the keyboard path, and the one that
// doesn't depend on hover timers.
async function openSubmenu(name: string): Promise<void> {
	const trigger = screen.getByRole("menuitem", { name })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowRight" })
		await Promise.resolve()
	})
}

const CUT_ENTRY = "Cut drive.cut"
const COPY_ENTRY = "Copy drive.copy"

function menuItemByText(text: string): HTMLElement {
	const found = screen.getAllByRole("menuitem").find(entry => entry.textContent === text)

	if (found === undefined) {
		throw new Error(`no menu item "${text}"`)
	}

	return found
}

function menuItem(name: string): HTMLElement {
	return screen.getByRole("menuitem", { name })
}

function isDisabled(element: HTMLElement): boolean {
	return element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled")
}

beforeEach(() => {
	treeResults.clear()
	queryClient.clear()
	useDriveClipboardStore.getState().clear()
})

afterEach(() => {
	cleanup()
	onlineManager.setOnline(true)
})

describe("DirectoryTreeSubmenu", () => {
	function renderGeneric(overrides: Partial<Parameters<typeof DirectoryTreeSubmenu>[0]> = {}) {
		const onSelect = vi.fn<(target: DirectoryTreeTarget) => void>()

		inOpenMenu(
			createElement(DirectoryTreeSubmenu, {
				family: DROPDOWN_TREE_MENU_FAMILY,
				label: "Send",
				icon: FolderInputIcon,
				actionLabel: "Send here",
				actionIcon: FolderInputIcon,
				isBrowseDisabled: () => false,
				isTargetDisabled: () => false,
				onSelect,
				...overrides
			})
		)

		return { onSelect }
	}

	it("offers the root action first, then the root's directories as submenus", async () => {
		seedTree()
		renderGeneric()

		await openSubmenu("Send")

		const items = screen.getAllByRole("menuitem").map(item => item.textContent)
		expect(items).toEqual(["Send", "Send here", "docs", "photos"])
		expect(menuItem("docs").getAttribute("aria-haspopup")).toBe("menu")
	})

	it("each directory's submenu offers its own action, then its children", async () => {
		seedTree()
		const { onSelect } = renderGeneric()

		await openSubmenu("Send")
		await openSubmenu("docs")

		const actions = screen.getAllByRole("menuitem", { name: "Send here" })
		expect(actions).toHaveLength(2)
		expect(screen.getByRole("menuitem", { name: "invoices" })).toBeDefined()

		// The last-mounted action is docs' own.
		const docsAction = actions.at(-1)
		if (!docsAction) {
			throw new Error("no docs action")
		}
		fireEvent.click(docsAction)

		expect(onSelect).toHaveBeenCalledExactlyOnceWith({ uuid: DOCS.data.uuid, ancestry: [DOCS.data.uuid] })
	})

	it("the root action selects the root target", async () => {
		seedTree()
		const { onSelect } = renderGeneric()

		await openSubmenu("Send")
		fireEvent.click(menuItem("Send here"))

		expect(onSelect).toHaveBeenCalledExactlyOnceWith({ uuid: null, ancestry: [] })
	})

	it("shows a spinner while a level loads, with its action disabled until it has", async () => {
		renderGeneric()

		await openSubmenu("Send")

		expect(screen.getByRole("status")).toBeDefined()
		expect(isDisabled(menuItem("Send here"))).toBe(true)
	})

	it("shows a disabled 'No directories' row for an empty level", async () => {
		seedLevel(null, [])
		renderGeneric()

		await openSubmenu("Send")

		expect(isDisabled(menuItem("No directories"))).toBe(true)
		expect(isDisabled(menuItem("Send here"))).toBe(false)
	})

	it("disables exactly the targets and directories its predicates name", async () => {
		seedTree()
		renderGeneric({
			isTargetDisabled: target => target.uuid === null,
			isBrowseDisabled: target => target.uuid === PHOTOS.data.uuid
		})

		await openSubmenu("Send")

		expect(isDisabled(menuItem("Send here"))).toBe(true)
		expect(isDisabled(menuItem("photos"))).toBe(true)
		expect(isDisabled(menuItem("docs"))).toBe(false)
	})

	it("renders the leading entries above the tree", async () => {
		seedTree()
		renderGeneric({ leading: "lead" })

		await openSubmenu("Send")

		expect(screen.getByText("lead")).toBeDefined()
		expect(screen.getByText("Cloud Drive")).toBeDefined()
	})
})

describe("MoveSubmenu", () => {
	function renderMove(items: DriveItem[]) {
		const onChooseDestination = vi.fn()

		inOpenMenu(createElement(MoveSubmenu, { family: DROPDOWN_TREE_MENU_FAMILY, items, onChooseDestination }))

		return { onChooseDestination }
	}

	it("opens the destination picker from its entry", async () => {
		seedTree()
		const { onChooseDestination } = renderMove([REPORT])

		await openSubmenu("Move")
		fireEvent.click(menuItem("Choose destination…"))

		expect(onChooseDestination).toHaveBeenCalledOnce()
		expect(performMoveMock).not.toHaveBeenCalled()
	})

	it("leads with Cut, which puts the items on the drive clipboard for a later paste", async () => {
		seedTree()
		renderMove([REPORT, PHOTOS])

		await openSubmenu("Move")
		const entries = screen.getAllByRole("menuitem").map(entry => entry.textContent)
		fireEvent.click(menuItemByText(CUT_ENTRY))

		expect(entries.indexOf(CUT_ENTRY)).toBeLessThan(entries.indexOf("Choose destination…"))
		expect(entries.indexOf(CUT_ENTRY)).not.toBe(-1)
		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "cut", items: [REPORT, PHOTOS] })
		expect(performMoveMock).not.toHaveBeenCalled()
	})

	it("'Move here' moves the whole selection into that directory", async () => {
		seedTree()
		renderMove([REPORT, PHOTOS])

		await openSubmenu("Move")
		await openSubmenu("docs")
		const docsAction = screen.getAllByRole("menuitem", { name: "Move here" }).at(-1)
		if (!docsAction) {
			throw new Error("no docs action")
		}
		fireEvent.click(docsAction)

		expect(performMoveMock).toHaveBeenCalledExactlyOnceWith([REPORT, PHOTOS], DOCS.data.uuid)
	})

	it("disables the moved directory itself (no browsing into it) but keeps its siblings", async () => {
		seedTree()
		renderMove([DOCS])

		await openSubmenu("Move")

		expect(isDisabled(menuItem("docs"))).toBe(true)
		expect(isDisabled(menuItem("photos"))).toBe(false)
		// DOCS already sits in the root.
		expect(isDisabled(menuItem("Move here"))).toBe(true)
	})

	it("disables 'Move here' on the current parent while its children stay browsable", async () => {
		seedTree()
		renderMove([REPORT])

		await openSubmenu("Move")
		expect(isDisabled(menuItem("Move here"))).toBe(false)

		await openSubmenu("docs")
		const [rootAction, docsAction] = screen.getAllByRole("menuitem", { name: "Move here" })
		expect(rootAction && isDisabled(rootAction)).toBe(false)
		expect(docsAction && isDisabled(docsAction)).toBe(true)
		expect(isDisabled(menuItem("invoices"))).toBe(false)
	})

	it("disables an undecryptable directory, as the dialog does", async () => {
		const locked = dirItem("locked", "root", { meta: { type: "encrypted", data: "cipher" } })
		seedLevel(null, [locked, PHOTOS])
		renderMove([REPORT])

		await openSubmenu("Move")

		expect(isDisabled(menuItem(locked.data.uuid))).toBe(true)
		expect(isDisabled(menuItem("photos"))).toBe(false)
	})

	it("disables every 'Move here' while offline", async () => {
		seedTree()
		renderMove([REPORT])

		await openSubmenu("Move")
		act(() => {
			onlineManager.setOnline(false)
		})

		expect(isDisabled(menuItem("Move here"))).toBe(true)
	})
})

describe("CopySubmenu", () => {
	function renderCopy(items: DriveItem[]) {
		const onChooseDestination = vi.fn()

		inOpenMenu(createElement(CopySubmenu, { family: DROPDOWN_TREE_MENU_FAMILY, items, onChooseDestination }))

		return { onChooseDestination }
	}

	it("opens the destination picker from its entry", async () => {
		seedTree()
		const { onChooseDestination } = renderCopy([REPORT])

		await openSubmenu("Copy")
		fireEvent.click(menuItem("Choose destination…"))

		expect(onChooseDestination).toHaveBeenCalledOnce()
		expect(startCopyWithCardMock).not.toHaveBeenCalled()
	})

	it("leads with Copy, which puts the items on the drive clipboard for a later paste", async () => {
		seedTree()
		renderCopy([REPORT])

		await openSubmenu("Copy")
		fireEvent.click(menuItemByText(COPY_ENTRY))

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items: [REPORT] })
		expect(startCopyWithCardMock).not.toHaveBeenCalled()
	})

	it("'Copy here' copies the selection into that directory, named for its card", async () => {
		seedTree()
		renderCopy([REPORT, PHOTOS])

		await openSubmenu("Copy")
		await openSubmenu("docs")
		const docsAction = screen.getAllByRole("menuitem", { name: "Copy here" }).at(-1)
		if (!docsAction) {
			throw new Error("no docs action")
		}
		fireEvent.click(docsAction)

		expect(startCopyWithCardMock).toHaveBeenCalledExactlyOnceWith([REPORT, PHOTOS], { uuid: DOCS.data.uuid, name: "docs" })
	})

	it("offers the copied items' own directory, which a move would refuse", async () => {
		seedTree()
		renderCopy([REPORT])

		await openSubmenu("Copy")
		await openSubmenu("docs")

		const docsAction = screen.getAllByRole("menuitem", { name: "Copy here" }).at(-1)
		if (!docsAction) {
			throw new Error("no docs action")
		}

		expect(isDisabled(docsAction)).toBe(false)
	})

	it("refuses a copied directory as its own destination", async () => {
		seedTree()
		renderCopy([DOCS])

		await openSubmenu("Copy")

		expect(isDisabled(menuItem("docs"))).toBe(true)
	})

	it("names the root after the drive", async () => {
		seedTree()
		renderCopy([REPORT])

		await openSubmenu("Copy")
		fireEvent.click(menuItem("Copy here"))

		expect(startCopyWithCardMock).toHaveBeenCalledExactlyOnceWith([REPORT], { uuid: null, name: "Cloud Drive" })
	})
})
