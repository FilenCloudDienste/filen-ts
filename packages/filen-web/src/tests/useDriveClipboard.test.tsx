// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, renderHook } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"

const { copyToClipboard, cutToClipboard, pasteClipboard, recheckClipboard, destinationDirectoryName } = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
	cutToClipboard: vi.fn(),
	pasteClipboard: vi.fn(() => Promise.resolve()),
	recheckClipboard: vi.fn(() => Promise.resolve(true)),
	destinationDirectoryName: vi.fn((_scope: string, _path: readonly string[]) => Promise.resolve<string | null>("dest"))
}))

// The real module is kept for its shortcut-context reader; its copy/move paths stay out of reach.
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/drive/lib/clipboard", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/clipboard")>()),
	copyToClipboard,
	cutToClipboard,
	pasteClipboard
}))
// Its lookups after a socket gap are clipboardSync.test.ts's.
vi.mock("@/features/drive/lib/clipboardRecheck", () => ({ recheckClipboard }))
// Its resolution order (listing row, breadcrumb entry, one worker call) is drive.test.ts's.
vi.mock("@/features/drive/queries/drive", () => ({
	destinationDirectoryName,
	directoryNameScope: (variant: string) => (variant === "sharedIn" || variant === "sharedOut" ? variant : "drive")
}))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))

import "@/lib/i18n"
import { registerAction } from "@/lib/keymap/registry"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { narrowItem } from "@/features/drive/lib/item"
import { useDriveClipboard, type UseDriveClipboardParams } from "@/features/drive/hooks/useDriveClipboard"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

const REPORT = narrowItem({
	uuid: "report-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "home-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.txt", mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
} satisfies File)

const DEST = "dest-0000-0000-0000-000000000000"

beforeAll(() => {
	for (const def of DRIVE_ACTIONS.filter(action => ["drive.copy", "drive.cut", "drive.paste"].includes(action.id))) {
		registerAction(def)
	}
})

beforeEach(() => {
	useDriveClipboardStore.getState().clear()
	const option = document.createElement("div")
	option.setAttribute("role", "option")
	option.tabIndex = 0
	option.textContent = "report.txt"
	document.body.replaceChildren(option, document.createElement("input"))
})

afterEach(() => {
	cleanup()
	window.getSelection()?.removeAllRanges()
})

function renderClipboard(overrides: Partial<UseDriveClipboardParams> = {}) {
	return renderHook(() =>
		useDriveClipboard({
			variant: "drive",
			uuid: DEST,
			ancestry: [DEST],
			listing: [],
			selectedItems: [REPORT],
			isOnline: true,
			isDialogOpen: false,
			...overrides
		})
	)
}

// mod resolves to Ctrl off macOS, which is what jsdom reports.
function press(target: Element, key: "c" | "x" | "v"): Event {
	const event = createEvent.keyDown(target, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true })

	fireEvent(target, event)

	return event
}

function row(): Element {
	return document.querySelector('[role="option"]') ?? document.body
}

function searchField(): Element {
	return document.querySelector("input") ?? document.body
}

describe("useDriveClipboard", () => {
	it("copies and cuts the selection from the listing, taking the keys from the browser", () => {
		renderClipboard()

		expect(press(row(), "c").defaultPrevented).toBe(true)
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith([REPORT])
		expect(press(row(), "x").defaultPrevented).toBe(true)
		expect(cutToClipboard).toHaveBeenCalledExactlyOnceWith([REPORT])
	})

	it("pastes into the directory on screen, by its name", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		const { result } = renderClipboard({ selectedItems: [] })

		expect(result.current.enabled).toBe(true)
		expect(press(row(), "v").defaultPrevented).toBe(true)

		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledExactlyOnceWith({ uuid: DEST, name: "dest" })
		})
	})

	// A directory opened by a deep link or a reveal often has no cached parent listing: its name is
	// resolved the way its breadcrumb resolves it, under the breadcrumb's scope and chain.
	it("names the destination through its breadcrumb's resolution, shared scope included", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		destinationDirectoryName.mockResolvedValueOnce("Shared dest")
		const { result } = renderClipboard({
			variant: "sharedOut",
			ancestry: ["root-0000-0000-0000-000000000000", DEST],
			selectedItems: []
		})

		act(() => {
			result.current.run()
		})

		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledExactlyOnceWith({ uuid: DEST, name: "Shared dest" })
		})
		expect(destinationDirectoryName).toHaveBeenCalledExactlyOnceWith("sharedOut", ["root-0000-0000-0000-000000000000", DEST])
	})

	it("still pastes when the name can't be resolved", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		destinationDirectoryName.mockRejectedValueOnce(new Error("no authenticated client"))
		const { result } = renderClipboard({ selectedItems: [] })

		act(() => {
			result.current.run()
		})

		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledExactlyOnceWith({ uuid: DEST, name: "" })
		})
	})

	it("doesn't paste when the items couldn't be looked up again", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		recheckClipboard.mockResolvedValueOnce(false)
		const { result } = renderClipboard({ selectedItems: [] })

		act(() => {
			result.current.run()
		})

		await vi.waitFor(() => {
			expect(recheckClipboard).toHaveBeenCalledOnce()
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(pasteClipboard).not.toHaveBeenCalled()
	})

	// A lookup after a socket gap can leave nothing to paste.
	it("asks again once the items were looked up, of the items as they now are", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		recheckClipboard.mockImplementationOnce(() => {
			useDriveClipboardStore.getState().clear()

			return Promise.resolve(true)
		})
		const { result } = renderClipboard({ selectedItems: [] })

		act(() => {
			result.current.run()
		})

		await vi.waitFor(() => {
			expect(recheckClipboard).toHaveBeenCalledOnce()
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(pasteClipboard).not.toHaveBeenCalled()
	})

	it("clears the clipboard, which it offers only while something is copied or cut", () => {
		const { result, rerender } = renderClipboard({ variant: "trash" })

		expect(result.current.clearable).toBe(false)

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "cut", items: [REPORT] })
		})
		rerender()

		// Clearable even where the paste itself isn't possible.
		expect(result.current.enabled).toBe(false)
		expect(result.current.clearable).toBe(true)

		act(() => {
			result.current.clear()
		})

		expect(useDriveClipboardStore.getState().entry).toBeNull()
		expect(result.current.clearable).toBe(false)
	})

	it("leaves text copy and paste in a field to the browser", () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		renderClipboard()

		for (const key of ["c", "x", "v"] as const) {
			expect(press(searchField(), key).defaultPrevented).toBe(false)
		}

		expect(copyToClipboard).not.toHaveBeenCalled()
		expect(cutToClipboard).not.toHaveBeenCalled()
		expect(pasteClipboard).not.toHaveBeenCalled()
	})

	it("leaves selected page text to the browser's own copy", () => {
		renderClipboard()
		const range = document.createRange()
		range.selectNodeContents(row())
		window.getSelection()?.addRange(range)

		expect(press(row(), "c").defaultPrevented).toBe(false)
		expect(copyToClipboard).not.toHaveBeenCalled()
	})

	it("stands down with nothing to act on, or with a dialog open", () => {
		const { unmount } = renderClipboard({ selectedItems: [] })

		expect(press(row(), "c").defaultPrevented).toBe(false)
		expect(press(row(), "v").defaultPrevented).toBe(false)

		unmount()
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		renderClipboard({ isDialogOpen: true })

		expect(press(row(), "c").defaultPrevented).toBe(false)
		expect(press(row(), "v").defaultPrevented).toBe(false)
		expect(copyToClipboard).not.toHaveBeenCalled()
		expect(pasteClipboard).not.toHaveBeenCalled()
	})
})
