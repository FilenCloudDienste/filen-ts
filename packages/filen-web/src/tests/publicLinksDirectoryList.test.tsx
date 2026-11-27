// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { DirPublicInfo, DirPublicLink, File as SdkFile, LinkedDir } from "@filen/sdk-rs"
import type { AnonDownloadOutcome } from "@/features/publicLinks/lib/download"
import type { SaveToDriveDialogProps } from "@/features/publicLinks/components/saveToDrive"
import { mockViewportHeight } from "@/tests/support/viewport"
import { withCode } from "@/tests/support/keys"
import "@/lib/i18n"

// The directory link's list: drive's selection model over the level on screen, its selection bar, and the
// per-row menus.

const { startAnonDirZipDownload, startAnonFileDownload, startAnonItemsZipDownload, saveable, dialog } = vi.hoisted(() => ({
	startAnonDirZipDownload: vi.fn<() => Promise<AnonDownloadOutcome>>(),
	startAnonFileDownload: vi.fn<() => Promise<AnonDownloadOutcome>>(),
	startAnonItemsZipDownload: vi.fn<() => Promise<AnonDownloadOutcome>>(),
	saveable: { current: false },
	dialog: { current: null as SaveToDriveDialogProps | null }
}))

vi.mock("@/features/publicLinks/lib/download", () => ({ startAnonDirZipDownload, startAnonFileDownload, startAnonItemsZipDownload }))
// A search's results: c.txt, in the level itself.
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		searchLinkedOpen: () => Promise.resolve(),
		searchLinkedRange: () => Promise.resolve({ total: 1, hits: [{ item: C_TXT, trail: [] }] }),
		searchLinkedClose: () => Promise.resolve()
	}
}))
vi.mock("@/features/publicLinks/queries/publicLink", () => ({
	useLinkSaveable: () => saveable.current,
	usePublicDirListing: () => ({ status: "success", data: LISTING, refetch: vi.fn() }),
	usePublicDirSize: () => ({ data: undefined }),
	usePublicVisitorSignedIn: () => ({ data: false }),
	usePublicViewModeQuery: () => ({ data: "list", refetch: () => Promise.resolve() })
}))
vi.mock("@/features/publicLinks/components/fileHero", () => ({
	FileHero: ({ onBack }: { onBack: () => void }) => createElement("button", { type: "button", onClick: onBack }, "file hero")
}))
vi.mock("@/features/publicLinks/components/saveToDrive", () => ({
	SaveToDriveButton: () => null,
	SaveToDriveDialog: (props: SaveToDriveDialogProps) => {
		dialog.current = props

		return null
	}
}))

import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

const ROOT_UUID = "d1000000-0000-0000-0000-000000000000"

function makeFile(uuid: `${string}-${string}-${string}-${string}`, name: string, size: bigint): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime: "text/plain", size, key: "k", version: 2, modified: 1n } },
		parent: ROOT_UUID,
		size,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

const SUB: LinkedDir = {
	inner: {
		uuid: "d2000000-0000-0000-0000-000000000000",
		parent: ROOT_UUID,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Sub" } }
	},
	linkedTag: true
}
const A_TXT = makeFile("f1000000-0000-0000-0000-000000000000", "a.txt", 1024n)
const B_TXT = makeFile("f2000000-0000-0000-0000-000000000000", "b.txt", 2048n)
const C_TXT = makeFile("f3000000-0000-0000-0000-000000000000", "c.txt", 4096n)
const LISTING = { dirs: [SUB], files: [A_TXT, B_TXT, C_TXT] }
const INFO = { root: { inner: { uuid: ROOT_UUID, meta: { type: "decoded", data: { name: "Photos" } } } } } as unknown as DirPublicInfo
const LINK = { enableDownload: true, linkKey: "key", password: undefined } as unknown as DirPublicLink

function renderBrowser(link: DirPublicLink = LINK): void {
	render(createElement(DirectoryBrowser, { info: INFO, link }))
}

function barButton(name: string): HTMLElement | null {
	return within(screen.getByRole("toolbar", { name: "Selection actions" })).queryByRole("button", { name })
}

function option(name: string): HTMLElement {
	return screen.getByRole("option", { name: new RegExp(`^${name}`) })
}

// A key on a focused row, as a click leaves it in a browser: the listbox's scoped actions act only on focus inside it.
function press(element: HTMLElement, init: { key: string; shiftKey?: boolean }): void {
	element.focus()
	fireEvent.keyDown(element, withCode(init))
}

// The row's name cell, ahead of its size and date.
function rowName(element: HTMLElement): string {
	return element.querySelector(".flex-1")?.textContent ?? ""
}

function selectedNames(): string[] {
	return screen
		.getAllByRole("option")
		.filter(element => element.getAttribute("aria-selected") === "true")
		.map(rowName)
}

beforeEach(() => {
	vi.clearAllMocks()
	mockViewportHeight(element => element.getAttribute("role") === "listbox", 800)
	saveable.current = false
	dialog.current = null
})

afterEach(() => {
	cleanup()
})

describe("DirectoryBrowser — the list", () => {
	it("lists the level directories first, with the select-all box and sortable columns over it", () => {
		renderBrowser()

		expect(screen.getAllByRole("option").map(rowName)).toEqual(["Sub", "a.txt", "b.txt", "c.txt"])
		expect(screen.getByRole("checkbox", { name: "Select all" }).getAttribute("aria-checked")).toBe("false")
		expect(screen.getByRole("button", { name: /^Name/ })).toBeDefined()
	})

	// jsdom lays nothing out: the classes are the contract. The list fills the page's main and scrolls its rows, but
	// never below its floor, past which the page (no min-h-0 above the list) grows and main scrolls instead.
	it("keeps the list a floor where the page is short, its rows out of the page's height", () => {
		renderBrowser()
		fireEvent.click(option("a.txt"), { detail: 1 })

		const listbox = screen.getByRole("listbox")
		const frame = listbox.parentElement
		const page = frame?.parentElement

		expect(listbox.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]))
		expect(frame?.className.split(" ")).toEqual(expect.arrayContaining(["min-h-60", "flex-1", "contain-size", "overflow-hidden"]))
		expect(page?.className.split(" ")).toContain("flex-1")
		expect(page?.className.split(" ")).not.toContain("min-h-0")
		// The selection bar sits below the list at its own height.
		expect(screen.getByRole("toolbar", { name: "Selection actions" }).closest(".shrink-0")?.parentElement).toBe(page)
	})

	it("selects on a click, toggles with Ctrl and extends with Shift", () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		expect(selectedNames()).toEqual(["a.txt"])

		fireEvent.click(option("c.txt"), { detail: 1, ctrlKey: true })
		expect(selectedNames()).toEqual(["a.txt", "c.txt"])

		fireEvent.click(option("Sub"), { detail: 1, shiftKey: true })
		expect(selectedNames()).toEqual(["Sub", "a.txt", "b.txt", "c.txt"])
	})

	it("deselects the sole selected row on a second plain click", () => {
		renderBrowser()

		fireEvent.click(option("b.txt"), { detail: 1 })
		fireEvent.click(option("b.txt"), { detail: 1 })

		expect(selectedNames()).toEqual([])
	})

	it("toggles a row from its own box without touching the rest", () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		const box = option("c.txt").querySelector("[aria-hidden]")

		if (box === null) {
			throw new Error("c.txt has no selection box")
		}

		fireEvent.click(box)

		expect(selectedNames()).toEqual(["a.txt", "c.txt"])
	})

	it("shows the selected files' count and size, and the plain count once a directory is among them", () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		fireEvent.click(option("b.txt"), { detail: 1, ctrlKey: true })
		expect(screen.getByText("2 selected · 3 KiB")).toBeDefined()

		fireEvent.click(option("Sub"), { detail: 1, ctrlKey: true })
		expect(screen.getByText("3 selected")).toBeDefined()
	})

	it("selects everything from the header box, then nothing", () => {
		renderBrowser()

		const box = screen.getByRole("checkbox", { name: "Select all" })

		fireEvent.click(box)
		expect(selectedNames()).toHaveLength(4)
		expect(box.getAttribute("aria-checked")).toBe("true")

		fireEvent.click(option("a.txt"), { detail: 1, ctrlKey: true })
		expect(box.getAttribute("aria-checked")).toBe("mixed")

		fireEvent.click(box)
		fireEvent.click(box)
		expect(selectedNames()).toEqual([])
		expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull()
	})

	it("clears the selection from the bar and with Escape", () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))
		expect(selectedNames()).toEqual([])

		fireEvent.click(option("a.txt"), { detail: 1 })
		press(option("a.txt"), { key: "Escape" })
		expect(selectedNames()).toEqual([])
	})

	it("drops the selection when the query changes and lists the search's matches", async () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		fireEvent.change(screen.getByRole("searchbox", { name: "Search this directory" }), { target: { value: "c" } })

		expect((await screen.findAllByRole("option")).map(rowName)).toEqual(["c.txt"])
		expect(selectedNames()).toEqual([])
	})

	it("moves the cursor with the arrows, extends with Shift and opens with Enter", () => {
		renderBrowser()

		fireEvent.click(option("Sub"), { detail: 1 })
		press(option("Sub"), { key: "ArrowDown", shiftKey: true })
		expect(selectedNames()).toEqual(["Sub", "a.txt"])

		press(option("a.txt"), { key: "ArrowUp" })
		expect(option("Sub").tabIndex).toBe(0)

		press(option("Sub"), { key: "Enter" })
		expect(screen.getByRole("heading", { name: "Sub" })).toBeDefined()
	})

	it("opens a directory on a double click and starts the next level with nothing selected", () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		fireEvent.doubleClick(option("Sub"))

		expect(screen.getByRole("heading", { name: "Sub" })).toBeDefined()
		expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull()
	})

	it("opens a file in place", () => {
		renderBrowser()

		fireEvent.doubleClick(option("b.txt"))

		expect(screen.getByText("file hero")).toBeDefined()
	})

	it("comes back from an opened file scrolled where it was, focused on the file's row, the selection kept", async () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })
		screen.getByRole("listbox").scrollTop = 24
		fireEvent.doubleClick(option("c.txt"))
		fireEvent.click(screen.getByRole("button", { name: "file hero" }))

		expect(screen.getByRole("listbox").scrollTop).toBe(24)
		await waitFor(() => {
			expect(document.activeElement).toBe(option("c.txt"))
		})
		expect(selectedNames()).toEqual(["a.txt"])

		// The keys go on from the opened file's row.
		fireEvent.keyDown(option("c.txt"), withCode({ key: "ArrowUp" }))
		expect(option("b.txt").tabIndex).toBe(0)

		// Escape leaves the next one the same way.
		press(option("b.txt"), { key: "Enter" })
		fireEvent.keyDown(document.body, withCode({ key: "Escape" }))
		await waitFor(() => {
			expect(document.activeElement).toBe(option("b.txt"))
		})
	})

	it("starts a subdirectory fresh after a file was opened and closed", async () => {
		renderBrowser()

		screen.getByRole("listbox").scrollTop = 24
		fireEvent.doubleClick(option("c.txt"))
		fireEvent.click(screen.getByRole("button", { name: "file hero" }))
		await waitFor(() => {
			expect(document.activeElement).toBe(option("c.txt"))
		})

		fireEvent.doubleClick(option("Sub"))

		expect(screen.getByRole("heading", { name: "Sub" })).toBeDefined()
		expect(screen.getByRole("listbox").scrollTop).toBe(0)
		expect(option("Sub").tabIndex).toBe(0)
		expect(option("c.txt").tabIndex).toBe(-1)
	})

	it("saves the selection to the visitor's drive in one job, a directory with its link", () => {
		saveable.current = true
		renderBrowser()

		fireEvent.click(option("Sub"), { detail: 1 })
		fireEvent.click(option("b.txt"), { detail: 1, ctrlKey: true })
		fireEvent.click(screen.getByRole("button", { name: "Save to Cloud Drive" }))

		expect(dialog.current?.items).toStrictEqual([{ dir: SUB, link: LINK }, B_TXT])
		expect(dialog.current?.name).toBe("Sub")
		expect(dialog.current?.glyph).toBe("items")
	})

	it("offers no Save for a link the visitor cannot save from", () => {
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })

		expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeDefined()
		expect(screen.queryByRole("button", { name: "Save to Cloud Drive" })).toBeNull()
	})

	it("downloads a row's file from its menu and says so when it fails", async () => {
		startAnonFileDownload.mockResolvedValueOnce({ status: "too-large" })
		renderBrowser()

		fireEvent.contextMenu(option("a.txt"))

		await act(async () => {
			fireEvent.click(await screen.findByRole("menuitem", { name: /^Download(?! as)/ }))
			await Promise.resolve()
		})

		expect(startAnonFileDownload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ file: A_TXT, name: "a.txt", size: 1024n }))
		expect(screen.getByText(/^This file is too large to download here/)).toBeDefined()
	})

	it("downloads a subdirectory as a zip from its menu", async () => {
		startAnonDirZipDownload.mockResolvedValueOnce({ status: "success" })
		renderBrowser()

		fireEvent.contextMenu(option("Sub"))

		await act(async () => {
			fireEvent.click(await screen.findByRole("menuitem", { name: /^Download as ZIP/ }))
			await Promise.resolve()
		})

		expect(startAnonDirZipDownload).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ dir: { dir: SUB, link: LINK }, name: "Sub" })
		)
	})

	it("downloads the selection as one zip named after the level, with the link beside the listed entries", async () => {
		let finish!: (outcome: AnonDownloadOutcome) => void

		startAnonItemsZipDownload.mockReturnValueOnce(
			new Promise(resolve => {
				finish = resolve
			})
		)
		renderBrowser()

		fireEvent.click(option("Sub"), { detail: 1 })
		fireEvent.click(option("b.txt"), { detail: 1, ctrlKey: true })
		fireEvent.click(barButton("Download") ?? document.body)

		expect(startAnonItemsZipDownload).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ items: [SUB, B_TXT], link: LINK, name: "Photos" })
		)
		expect(barButton("Download")?.hasAttribute("disabled")).toBe(true)

		await act(async () => {
			finish({ status: "too-large" })
			await Promise.resolve()
		})

		expect(barButton("Download")?.hasAttribute("disabled")).toBe(false)
		expect(screen.getByText(/^This selection is too large to download here/)).toBeDefined()
	})

	it("downloads a lone selected file as the file itself", async () => {
		startAnonFileDownload.mockResolvedValueOnce({ status: "success" })
		renderBrowser()

		fireEvent.click(option("a.txt"), { detail: 1 })

		await act(async () => {
			fireEvent.click(barButton("Download") ?? document.body)
			await Promise.resolve()
		})

		expect(startAnonFileDownload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ file: A_TXT, name: "a.txt" }))
		expect(startAnonItemsZipDownload).not.toHaveBeenCalled()
	})

	it("offers no Download in the bar for a link with downloads disabled", () => {
		renderBrowser({ ...LINK, enableDownload: false })

		fireEvent.click(option("a.txt"), { detail: 1 })

		expect(barButton("Download")).toBeNull()
	})
})
