// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, renderHook } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"

const { copyToClipboard, cutToClipboard, pasteClipboard, recheckClipboard, destinationDirectoryName, uploadFileSet } = vi.hoisted(() => ({
	uploadFileSet: vi.fn(),
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
vi.mock("@/features/drive/lib/clipboardRecheck", () => ({
	recheckClipboard,
	asListed: (items: readonly DriveItem[]) => ({ items: [...items], current: true })
}))
// Its resolution order (listing row, breadcrumb entry, one worker call) is drive.test.ts's.
vi.mock("@/features/drive/queries/drive", () => ({
	destinationDirectoryName,
	directoryNameScope: (variant: string) => (variant === "sharedIn" || variant === "sharedOut" ? variant : "drive")
}))
// Its routing (native host, directory walk, flat upload) is uploadDropNative.test.ts's.
vi.mock("@/features/drive/lib/uploadDrop", () => ({ uploadFileSet }))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))

import "@/lib/i18n"
import { registerAction } from "@/lib/keymap/registry"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
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
} satisfies SdkFile)

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

// A paste event as the browser fires it after mod+v or the Edit menu's Paste, carrying `files`.
function pasteEvent(target: Element, files: File[] = []): Event {
	const event = createEvent.paste(target, {
		clipboardData: { files, items: files.map(file => ({ kind: "file", getAsFile: () => file })) }
	})

	fireEvent(target, event)

	return event
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
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
		// The key leaves the browser its paste event, which tells whether the system clipboard holds files.
		expect(press(row(), "v").defaultPrevented).toBe(false)
		expect(pasteEvent(row()).defaultPrevented).toBe(true)

		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledExactlyOnceWith({ uuid: DEST, name: "dest" })
		})
		await wait(300)
		expect(pasteClipboard).toHaveBeenCalledOnce()
	})

	// A browser that fires no paste event outside an editable element.
	it("pastes on the key alone when no paste event follows it, and once only", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		renderClipboard({ selectedItems: [] })

		press(row(), "v")
		await wait(300)
		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledExactlyOnceWith({ uuid: DEST, name: "dest" })
		})

		// The event arrives after all.
		pasteEvent(row())
		await wait(0)
		expect(pasteClipboard).toHaveBeenCalledOnce()
	})

	it("uploads files pasted from the system clipboard into the directory on screen, before the drive clipboard", async () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		renderClipboard({ selectedItems: [] })
		const notes = new File(["notes"], "notes.txt", { type: "text/plain" })
		const screenshot = new File(["png"], "image.png", { type: "image/png" })

		press(row(), "v")
		expect(pasteEvent(row(), [notes, screenshot]).defaultPrevented).toBe(true)

		expect(uploadFileSet).toHaveBeenCalledOnce()
		const [files, entries, parent] = uploadFileSet.mock.calls[0] as [File[], FileSystemEntry[], string | null]

		expect(files[0]).toBe(notes)
		expect(files[1]?.name).toMatch(/^Pasted image \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/)
		expect(files[1]?.type).toBe("image/png")
		expect(entries).toEqual([])
		expect(parent).toBe(DEST)

		await wait(300)
		expect(pasteClipboard).not.toHaveBeenCalled()
	})

	// The system clipboard as a paste event reads it: files until a write replaces them with text.
	function fakeSystemClipboard(files: File[], refuse = false): { files: File[] } {
		const system = { files }

		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: () => {
					if (refuse) {
						return Promise.reject(new DOMException("denied", "NotAllowedError"))
					}

					system.files = []

					return Promise.resolve()
				}
			}
		})

		return system
	}

	async function copyInApp(items: DriveItem[]): Promise<void> {
		const actual = await vi.importActual<typeof import("@/features/drive/lib/clipboard")>("@/features/drive/lib/clipboard")

		actual.copyToClipboard(items)
		await wait(0)
	}

	it("pastes a drive copy made after a screenshot, uploading nothing", async () => {
		const system = fakeSystemClipboard([new File(["png"], "image.png", { type: "image/png" })])

		await copyInApp([REPORT])
		renderClipboard({ selectedItems: [] })

		press(row(), "v")
		expect(pasteEvent(row(), system.files).defaultPrevented).toBe(true)
		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledExactlyOnceWith({ uuid: DEST, name: "dest" })
		})
		expect(uploadFileSet).not.toHaveBeenCalled()
	})

	it("pastes a drive copy whose names the system clipboard refused over the older files it still holds", async () => {
		const system = fakeSystemClipboard([new File(["png"], "image.png", { type: "image/png" })], true)

		await copyInApp([REPORT])
		renderClipboard({ selectedItems: [] })

		expect(pasteEvent(row(), system.files).defaultPrevented).toBe(true)
		await vi.waitFor(() => {
			expect(pasteClipboard).toHaveBeenCalledOnce()
		})
		expect(uploadFileSet).not.toHaveBeenCalled()

		// A later copy whose names land leaves the system clipboard current again for the tests after this one.
		fakeSystemClipboard([])
		await copyInApp([REPORT])
	})

	it("uploads pasted files from the Edit menu's Paste, with nothing copied in the app", () => {
		renderClipboard({ selectedItems: [] })

		expect(pasteEvent(row(), [new File(["a"], "a.txt")]).defaultPrevented).toBe(true)
		expect(uploadFileSet).toHaveBeenCalledOnce()
	})

	it("leaves a paste of files alone where the directory on screen takes no uploads", () => {
		for (const overrides of [{ variant: "trash" }, { isOnline: false }, { listing: undefined }] as const) {
			const { unmount } = renderClipboard({ selectedItems: [], ...overrides })

			expect(pasteEvent(row(), [new File(["a"], "a.txt")]).defaultPrevented).toBe(false)
			unmount()
		}

		expect(uploadFileSet).not.toHaveBeenCalled()
	})

	it("never takes a paste in a field or under a dialog", () => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [REPORT] })
		renderClipboard({ selectedItems: [] })

		expect(pasteEvent(searchField(), [new File(["a"], "a.txt")]).defaultPrevented).toBe(false)

		const dialog = document.createElement("div")
		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.append(dialog)

		expect(pasteEvent(row(), [new File(["a"], "a.txt")]).defaultPrevented).toBe(false)
		expect(pasteEvent(row()).defaultPrevented).toBe(false)
		expect(uploadFileSet).not.toHaveBeenCalled()
		expect(pasteClipboard).not.toHaveBeenCalled()
	})

	it("stops listening once the listing is gone", () => {
		const { unmount } = renderClipboard({ selectedItems: [] })

		unmount()

		expect(pasteEvent(row(), [new File(["a"], "a.txt")]).defaultPrevented).toBe(false)
		expect(uploadFileSet).not.toHaveBeenCalled()
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

	// The connection and the listing as they are once the lookup settles, not as the render that took the
	// paste saw them.
	it("asks again against the connection and the listing as they now are", async () => {
		useDriveClipboardStore.getState().set({ mode: "cut", items: [REPORT] })
		const { result, rerender } = renderHook(
			({ listing }: { listing: DriveItem[] }) =>
				useDriveClipboard({
					variant: "drive",
					uuid: DEST,
					ancestry: [DEST],
					listing,
					selectedItems: [],
					isOnline: true
				}),
			{ initialProps: { listing: [] as DriveItem[] } }
		)

		recheckClipboard.mockImplementationOnce(() => {
			onlineManager.setOnline(false)

			return Promise.resolve(true)
		})
		act(() => {
			result.current.run()
		})
		await vi.waitFor(() => {
			expect(recheckClipboard).toHaveBeenCalledOnce()
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		onlineManager.setOnline(true)
		expect(pasteClipboard).not.toHaveBeenCalled()

		act(() => {
			result.current.run()
		})
		// The cut item lands in the listing before the lookup settles: pasting it there is now a no-op.
		rerender({ listing: [REPORT] })
		await vi.waitFor(() => {
			expect(recheckClipboard).toHaveBeenCalledTimes(2)
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
		const dialog = document.createElement("div")
		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.append(dialog)
		renderClipboard()

		expect(press(row(), "c").defaultPrevented).toBe(false)
		expect(press(row(), "v").defaultPrevented).toBe(false)
		expect(copyToClipboard).not.toHaveBeenCalled()
		expect(pasteClipboard).not.toHaveBeenCalled()
	})
})
