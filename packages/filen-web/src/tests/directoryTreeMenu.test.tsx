// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider, onlineManager, type UseQueryResult } from "@tanstack/react-query"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"

// Every worker call the tree menu could make lands here: opening it must make none.
const { sdkCalls, pasteWhenStillValid, navigate } = vi.hoisted(() => ({
	sdkCalls: [] as string[],
	pasteWhenStillValid: vi.fn((_can: unknown, _destination: () => Promise<unknown>) => Promise.resolve()),
	navigate: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: new Proxy(
		{},
		{
			get: (_target, key) => {
				sdkCalls.push(String(key))

				return () => Promise.reject(new Error("no worker under vitest"))
			}
		}
	)
}))
// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
}))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))
// The clipboard entries' shortcut badge, reduced to its action id (the registry's combos aren't the point).
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})
// The paste itself (recheck + copy card / move) is clipboard.test.ts's; here only what it is asked to do.
vi.mock("@/features/drive/lib/clipboardPaste", () => ({ pasteWhenStillValid }))
vi.mock("@tanstack/react-router", async importOriginal => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigate,
	useRouterState: ({ select }: { select: (state: unknown) => unknown }) => select({ location: { href: "/drive", pathname: "/drive" } })
}))
// The row's own affordances that are not what these assertions are about.
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/hooks/useDriveDropTarget", () => ({
	dropHighlightClass: () => false,
	useDriveDropTarget: () => ({
		isOver: false,
		mode: "move",
		onDragEnter: () => undefined,
		onDragOver: () => undefined,
		onDragLeave: () => undefined,
		onDrop: () => undefined
	})
}))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { registerAction } from "@/lib/keymap/registry"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryKey, projectTreeChildren, type DirectoryTreeChild } from "@/features/drive/queries/drive"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"
import { DirectoryTreeMenu } from "@/features/drive/components/directoryTreeMenu"
import { DriveRow } from "@/features/drive/components/driveRow"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT = testUuid("root")

function dirItem(label: string, name: string, parent: string): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		parent: parent as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

const DOCS = dirItem("docs", "Docs", ROOT)
const INNER = dirItem("inner", "Inner", testUuid("docs"))
const REPORT = narrowItem({
	uuid: testUuid("report"),
	stableUUID: undefined,
	parent: ROOT,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.txt", mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
} satisfies File)

// The destination entries a tree node's menu opens with, ahead of the row's own.
const TARGET_ENTRIES = ["Open", "New directory", "Upload files", "Upload directory", "New text file", "Paste drive.paste"]

const LISTINGS = new Map<string | null, DriveItem[]>([
	[null, [DOCS, REPORT]],
	[testUuid("docs"), [INNER]]
])

function resolved(data: DirectoryTreeChild[]): UseQueryResult<DirectoryTreeChild[]> {
	return { status: "success", data } as UseQueryResult<DirectoryTreeChild[]>
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

// The sidebar's shape: a root row, then the tree below it, all inside the one trigger list.
function renderTree() {
	const tree: DirectoryTreeContext = {
		activePath: [],
		isOpen: uuid => uuid === testUuid("docs"),
		onToggle: () => undefined,
		onNavigate: () => undefined,
		useChildren: uuid => resolved(projectTreeChildren(LISTINGS.get(uuid) ?? []))
	}
	const onNavigate = vi.fn()

	render(
		createElement(DirectoryTreeMenu, {
			onNavigate,
			render: createElement(
				"ul",
				{ "aria-label": "Directory tree" },
				createElement(
					"li",
					null,
					createElement("div", { "data-tree-path": "" }, createElement("button", { type: "button" }, "Cloud Drive")),
					createElement(DirectoryTree, { tree })
				)
			)
		}),
		{ wrapper }
	)

	return { onNavigate }
}

// A row's name button (the chevron is the row's first button). Looked up before a menu opens: an open
// menu hides the page behind it from the accessibility tree.
function rowButton(name: string): HTMLElement {
	return screen.getByRole("button", { name })
}

async function openMenuOn(element: HTMLElement): Promise<void> {
	await act(async () => {
		fireEvent.contextMenu(element)
		await Promise.resolve()
	})
}

function menuEntries(): string[] {
	return screen.getAllByRole("menuitem").map(entry => entry.textContent.trim())
}

function entry(name: string): HTMLElement {
	const match = screen.getAllByRole("menuitem").find(item => item.textContent.trim().startsWith(name))

	if (match === undefined) {
		throw new Error(`no menu entry "${name}"`)
	}

	return match
}

function isDisabled(element: HTMLElement): boolean {
	return element.hasAttribute("data-disabled")
}

beforeAll(() => {
	for (const def of DRIVE_ACTIONS.filter(action => ["drive.copy", "drive.cut", "drive.paste"].includes(action.id))) {
		registerAction(def)
	}
})

beforeEach(() => {
	queryClient.clear()

	for (const [uuid, items] of LISTINGS) {
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid }), items)
	}

	useDriveClipboardStore.getState().clear()
	useDriveStore.setState({ selectedItems: [] })
	sdkCalls.length = 0
})

afterEach(() => {
	cleanup()
})

describe("sidebar tree menu", () => {
	it("opens on a node with the destination entries, then exactly the entries its listing row offers", async () => {
		render(
			createElement(DriveRow, {
				item: DOCS,
				index: 0,
				total: 1,
				selected: false,
				active: false,
				variant: "drive",
				style: {},
				splat: "",
				directorySizes: new Map(),
				selectedItems: [],
				onPointerSelect: () => undefined,
				onCursorMove: () => undefined,
				onOpen: () => undefined,
				onItemAction: () => undefined,
				onBulkAction: () => undefined,
				registerRef: () => undefined
			})
		)
		await openMenuOn(screen.getByRole("option"))
		const rowEntries = menuEntries()
		cleanup()

		renderTree()
		await openMenuOn(rowButton("Docs"))

		expect(rowEntries).toContain("Rename")
		expect(menuEntries()).toEqual([...TARGET_ENTRIES, ...rowEntries])
	})

	it("opens on the Cloud Drive root with the destination entries alone", async () => {
		renderTree()
		await openMenuOn(rowButton("Cloud Drive"))

		expect(menuEntries()).toEqual(TARGET_ENTRIES)
	})

	it("keeps the browser's own menu off every row", async () => {
		renderTree()
		const list = screen.getByRole("list", { name: "Directory tree" })
		const event = createEvent.contextMenu(list)

		await act(async () => {
			fireEvent(list, event)
			await Promise.resolve()
		})

		expect(event.defaultPrevented).toBe(false)
		expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
	})

	// The Menu key and Shift+F10 fire contextmenu on the focused element, which is what this dispatches.
	it("opens for the focused node from the keyboard's contextmenu, and hands focus back on close", async () => {
		renderTree()
		const inner = rowButton("Inner")

		inner.focus()
		await openMenuOn(inner)
		expect(entry("Open")).toBeTruthy()

		await act(async () => {
			fireEvent.keyDown(entry("Open"), { key: "Escape" })
			await Promise.resolve()
		})

		expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
		expect(document.activeElement).toBe(inner)
	})

	it("opens without a single worker call", async () => {
		renderTree()
		const root = rowButton("Cloud Drive")

		await openMenuOn(rowButton("Docs"))
		await openMenuOn(root)

		expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0)
		expect(sdkCalls).toEqual([])
	})

	it("opens the node it was opened on", async () => {
		const { onNavigate } = renderTree()

		await openMenuOn(rowButton("Inner"))
		fireEvent.click(entry("Open"))

		expect(onNavigate).toHaveBeenCalledExactlyOnceWith([testUuid("docs"), testUuid("inner")])
	})

	it("offers Paste only where the clipboard can land: never into a copied directory or below it", async () => {
		act(() => {
			useDriveClipboardStore.getState().set({ mode: "copy", items: [DOCS] })
		})
		renderTree()
		const root = rowButton("Cloud Drive")

		await openMenuOn(rowButton("Inner"))
		expect(isDisabled(entry("Paste"))).toBe(true)

		await openMenuOn(root)
		expect(isDisabled(entry("Paste"))).toBe(false)
	})

	it("refuses a cut back into its own parent, and pastes it elsewhere under the node's name", async () => {
		act(() => {
			useDriveClipboardStore.getState().set({ mode: "cut", items: [REPORT] })
		})
		renderTree()
		const inner = rowButton("Inner")

		await openMenuOn(rowButton("Cloud Drive"))
		expect(isDisabled(entry("Paste"))).toBe(true)

		await openMenuOn(inner)
		fireEvent.click(entry("Paste"))

		expect(pasteWhenStillValid).toHaveBeenCalledOnce()
		const [canPasteEntry, destination] = pasteWhenStillValid.mock.calls[0] ?? []
		await expect(destination?.()).resolves.toEqual({ uuid: testUuid("inner"), name: "Inner" })

		// Judged again as things are when the recheck settles, not as the menu saw them.
		const judge = canPasteEntry as (entry: unknown) => boolean
		const entryNow = useDriveClipboardStore.getState().entry

		expect(judge(entryNow)).toBe(true)
		onlineManager.setOnline(false)
		expect(judge(entryNow)).toBe(false)
		onlineManager.setOnline(true)
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: testUuid("inner") }), [REPORT])
		expect(judge(entryNow)).toBe(false)
	})

	// The sidebar precedes the listing in the page: standing pickers there would be the first file inputs
	// any page-wide lookup finds, and they upload into whatever the tree last targeted.
	it("mounts its own pickers only while the menu or an upload it started is in use", async () => {
		renderTree()
		const docs = rowButton("Docs")

		expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0)

		await openMenuOn(docs)
		expect(screen.getByTestId("drive-tree-upload-files-input")).toBeTruthy()
		expect(screen.getByTestId("drive-tree-upload-directory-input")).toBeTruthy()
		expect(screen.queryByTestId("drive-upload-directory-input")).toBeNull()

		await act(async () => {
			fireEvent.click(entry("Upload files"))
			await Promise.resolve()
		})

		expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
		const picker = screen.getByTestId("drive-tree-upload-files-input")

		act(() => {
			picker.dispatchEvent(new Event("cancel"))
		})

		expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0)
	})
})

describe("sidebar tree clipboard shortcuts", () => {
	// mod resolves to Ctrl off macOS, which is what jsdom reports.
	function press(target: Element, key: "c" | "x" | "v"): Event {
		const event = createEvent.keyDown(target, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true })

		fireEvent(target, event)

		return event
	}

	it("copies and cuts the focused node's directory, and keeps the listing's own shortcut out of it", () => {
		const documentKeydown = vi.fn()
		document.addEventListener("keydown", documentKeydown)
		renderTree()
		const docs = rowButton("Docs")

		docs.focus()
		expect(press(docs, "c").defaultPrevented).toBe(true)
		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items: [DOCS] })

		expect(press(docs, "x").defaultPrevented).toBe(true)
		expect(useDriveClipboardStore.getState().entry?.mode).toBe("cut")

		document.removeEventListener("keydown", documentKeydown)
		expect(documentKeydown).not.toHaveBeenCalled()
	})

	it("pastes into the focused node, and stands down where it can't", () => {
		act(() => {
			useDriveClipboardStore.getState().set({ mode: "copy", items: [DOCS] })
		})
		renderTree()
		const inner = rowButton("Inner")
		const root = rowButton("Cloud Drive")

		inner.focus()
		expect(press(inner, "v").defaultPrevented).toBe(false)
		expect(pasteWhenStillValid).not.toHaveBeenCalled()

		root.focus()
		expect(press(root, "v").defaultPrevented).toBe(true)
		expect(pasteWhenStillValid).toHaveBeenCalledOnce()
	})

	it("dims a cut node until the clipboard changes", () => {
		renderTree()
		const row = rowButton("Docs").closest("[data-tree-path]")

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "cut", items: [DOCS] })
		})
		expect(row?.hasAttribute("data-cut")).toBe(true)

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "copy", items: [DOCS] })
		})
		expect(row?.hasAttribute("data-cut")).toBe(false)
	})
})
