// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"

// The slideshow in the preview overlay: its ▶ and keys, the header it replaces, a dirty slot, Escape, and the
// subdirectories' list the host swaps in and back.

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/media/wakeLock", () => ({ createScreenWakeLock: () => ({ set: vi.fn(), dispose: vi.fn() }) }))
vi.mock("@/features/preview/lib/previewPrefetch", () => ({ prefetchPreviewImage: () => null }))
vi.mock("@/features/drive/lib/thumbnails", async () => ({
	...(await vi.importActual<typeof import("@/features/drive/lib/thumbnails")>("@/features/drive/lib/thumbnails")),
	peekThumbnailUrl: () => null
}))

const tree = vi.hoisted(() => ({ fetch: vi.fn<(source: unknown, signal: AbortSignal) => Promise<unknown[]>>() }))

vi.mock("@/features/preview/lib/slideshowTree", () => ({ fetchSlideshowTree: tree.fetch }))

// The viewer: its file's name, a video element for a video, and a way to leave unsaved edits.
vi.mock("@/features/preview/components/previewBody", () => ({
	PreviewBody: ({ item, onDirtyChange }: { item: { data: { uuid: string } }; onDirtyChange: (dirty: boolean) => void }) =>
		createElement(
			"div",
			null,
			createElement("button", { type: "button" }, `viewer ${item.data.uuid}`),
			createElement("video", { "data-testid": "video", tabIndex: 0 }),
			createElement(
				"button",
				{
					type: "button",
					onClick: () => {
						onDirtyChange(true)
					}
				},
				"edit"
			)
		)
}))

import "@/lib/i18n"
import { i18n } from "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { PreviewOverlay, type PreviewOverlayProps } from "@/features/preview/components/previewOverlay"
import { setSlideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import { setPreviewDirty } from "@/features/preview/store/usePreviewUnsavedGuard"
import { emitPreviewItemRemoved } from "@/features/preview/lib/previewReconcile"
import { listingSlideshowSource } from "@/features/drive/components/directoryListing.logic"
import type { SlideshowSource } from "@/features/preview/lib/slideshowTree"
import { withCode } from "@/tests/support/keys"
import { testUuid } from "@/tests/support/uuid"

registerAllActions()

function fileNamed(name: string): DriveItem {
	const file: File = {
		uuid: testUuid(name.replace(/\W/g, "")),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1000n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1000n, key: "k", version: 2 }
		}
	}

	return narrowItem(file)
}

const A = fileNamed("a.jpg")
const B = fileNamed("b.jpg")
const DOC = fileNamed("doc.pdf")
const SUB = fileNamed("sub.jpg")
const SOURCE: SlideshowSource = { kind: "owned", uuid: testUuid("dir"), hideDotFiles: true, dotFilenRoot: null }

interface Host {
	props: PreviewOverlayProps
	rerender: () => void
}

// A host that holds the pager list and index as the drive's dialog host does.
function renderOverlay(items: DriveItem[], index: number, extra: Partial<PreviewOverlayProps> = {}): Host {
	const host: Host = {
		props: {
			variant: "drive",
			items,
			index,
			onStep: vi.fn((delta: number) => {
				host.props = { ...host.props, index: host.props.index + delta }
				host.rerender()
			}),
			onClose: vi.fn(),
			onItemRemoved: vi.fn(),
			...extra
		},
		rerender: () => undefined
	}

	const view = render(createElement(PreviewOverlay, host.props))

	host.rerender = () => {
		view.rerender(createElement(PreviewOverlay, host.props))
	}

	return host
}

function withReplace(host: Host): void {
	host.props = {
		...host.props,
		onItemsReplaced: vi.fn((items: DriveItem[], index: number) => {
			host.props = { ...host.props, items, index }
			host.rerender()
		})
	}
	host.rerender()
}

function startButton(): HTMLElement | null {
	return screen.queryByRole("button", { name: /^Slideshow/ })
}

function bar(): HTMLElement | null {
	return screen.queryByRole("group", { name: "Slideshow controls" })
}

function subfoldersToggle(): HTMLElement | null {
	return screen.queryByRole("button", { name: /Include subdirectories/ })
}

// Throws, naming the toggle, when it is missing.
function clickSubfolders(): void {
	fireEvent.click(screen.getByRole("button", { name: /Include subdirectories/ }))
}

// Starts the slideshow with the subdirectories preference on, the tree landing as it starts.
async function startWithTree(): Promise<void> {
	await act(async () => {
		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
		await Promise.resolve()
	})
}

function popup(): HTMLElement {
	return screen.getByRole("dialog")
}

beforeEach(async () => {
	await i18n.changeLanguage("en")
	setSlideshowPrefs({ intervalSeconds: 5, shuffle: false, subfolders: false })
	tree.fetch.mockReset()
})

afterEach(() => {
	act(() => {
		setPreviewDirty(false)
	})
	cleanup()
	vi.useRealTimers()
})

describe("PreviewOverlay slideshow", () => {
	it("▶ shows with two images and starts the slideshow", async () => {
		renderOverlay([A, DOC, B], 0)

		const start = await screen.findByRole("button", { name: /^Slideshow/ })

		fireEvent.click(start)

		expect(bar()).not.toBeNull()
		expect(screen.getByText("1/2")).toBeTruthy()
	})

	it("no ▶ for a single slideable item", async () => {
		renderOverlay([A, DOC], 0)

		await screen.findByRole("button", { name: `viewer ${A.data.uuid}` })
		expect(startButton()).toBeNull()
	})

	it("the header hides while running and returns on end", async () => {
		renderOverlay([A, B], 0)

		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
		expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
		expect(screen.queryByRole("banner")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "End slideshow" }))
		expect(bar()).toBeNull()
		expect(startButton()).not.toBeNull()
	})

	it("Space pauses only while running", async () => {
		renderOverlay([A, B], 0)

		await screen.findByRole("button", { name: /^Slideshow/ })

		const idle = new KeyboardEvent("keydown", { ...withCode({ key: " " }), bubbles: true, cancelable: true })

		popup().dispatchEvent(idle)
		expect(idle.defaultPrevented).toBe(false)

		fireEvent.keyDown(popup(), withCode({ key: "s" }))
		expect(bar()).not.toBeNull()
		expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy()

		fireEvent.keyDown(popup(), withCode({ key: " " }))
		expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy()

		fireEvent.keyDown(popup(), withCode({ key: " " }))
		expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy()
	})

	it("a dirty slot pauses instead of prompting", async () => {
		const host = renderOverlay([A, B], 0)

		fireEvent.click(await screen.findByRole("button", { name: "edit" }))
		vi.useFakeTimers()
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))

		// The slide never reports shown: it is due after the show timeout, and cannot be left.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(16_000)
		})

		expect(host.props.onStep).not.toHaveBeenCalled()
		expect(screen.queryByText("Unsaved changes")).toBeNull()
		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy()
	})

	it("subfolders on replaces the list with the tree at the current item", async () => {
		tree.fetch.mockResolvedValue([SUB, B, A])

		const host = renderOverlay([A, B], 1, { slideshowSource: SOURCE })

		withReplace(host)
		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))

		await act(async () => {
			clickSubfolders()
			await Promise.resolve()
		})

		expect(tree.fetch).toHaveBeenCalledOnce()
		expect(host.props.onItemsReplaced).toHaveBeenCalledWith([SUB, B, A], 1)
		expect(screen.getByText("2/3")).toBeTruthy()
	})

	it("subfolders off returns to the opening list", async () => {
		setSlideshowPrefs({ subfolders: true })
		tree.fetch.mockResolvedValue([SUB, A, B])

		// Started on the opening list's last file, which the tree holds elsewhere.
		const host = renderOverlay([DOC, A, B], 2, { slideshowSource: SOURCE })

		withReplace(host)
		await startWithTree()

		expect(host.props.items).toEqual([SUB, A, B])
		expect(host.props.index).toBe(2)

		// Off on a file of the opening list: back at that file.
		clickSubfolders()
		expect(host.props.onItemsReplaced).toHaveBeenLastCalledWith([DOC, A, B], 2)

		await act(async () => {
			clickSubfolders()
			await Promise.resolve()
		})
		expect(host.props.items).toEqual([SUB, A, B])

		// Off on a file only the tree holds: back at the opening list's first item.
		act(() => {
			host.props.onStep(-2)
		})
		clickSubfolders()
		expect(host.props.onItemsReplaced).toHaveBeenLastCalledWith([DOC, A, B], 0)
		expect(host.props.items).toEqual([DOC, A, B])
	})

	it("ending the slideshow restores the opening list at the current file", async () => {
		setSlideshowPrefs({ subfolders: true })
		tree.fetch.mockResolvedValue([SUB, A, B])

		const host = renderOverlay([DOC, A, B], 1, { slideshowSource: SOURCE })

		withReplace(host)
		await startWithTree()
		expect(host.props.index).toBe(1)

		act(() => {
			host.props.onStep(1)
		})
		fireEvent.click(screen.getByRole("button", { name: "End slideshow" }))

		expect(host.props.onItemsReplaced).toHaveBeenLastCalledWith([DOC, A, B], 2)
		expect(host.props.items).toEqual([DOC, A, B])
		expect(bar()).toBeNull()
	})

	it("ending on a file only the tree holds restores the file it started from", async () => {
		setSlideshowPrefs({ subfolders: true })
		tree.fetch.mockResolvedValue([SUB, A, B])

		const host = renderOverlay([DOC, A, B], 2, { slideshowSource: SOURCE })

		withReplace(host)
		await startWithTree()

		act(() => {
			host.props.onStep(-2)
		})
		expect(host.props.items[host.props.index]).toBe(SUB)

		fireEvent.keyDown(popup(), withCode({ key: "Escape" }))

		expect(host.props.onItemsReplaced).toHaveBeenLastCalledWith([DOC, A, B], 2)
		expect(host.props.onClose).not.toHaveBeenCalled()
	})

	it("a tree still loading when the slideshow ends never swaps in", async () => {
		setSlideshowPrefs({ subfolders: true })

		let land: (items: DriveItem[]) => void = () => undefined

		tree.fetch.mockReturnValue(
			new Promise(resolve => {
				land = resolve
			})
		)

		const host = renderOverlay([A, B], 0, { slideshowSource: SOURCE })

		withReplace(host)
		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
		expect(tree.fetch).toHaveBeenCalledOnce()

		fireEvent.keyDown(popup(), withCode({ key: "Escape" }))
		expect(bar()).toBeNull()
		expect(tree.fetch.mock.calls[0]?.[1].aborted).toBe(true)

		await act(async () => {
			land([SUB, A, B])
			await Promise.resolve()
		})

		expect(host.props.onItemsReplaced).not.toHaveBeenCalled()
		expect(host.props.items).toEqual([A, B])
	})

	it("a file removed while subfolders are on never comes back with the opening list", async () => {
		setSlideshowPrefs({ subfolders: true })
		tree.fetch.mockResolvedValue([SUB, A, B])

		const host = renderOverlay([A, DOC, B], 0, { slideshowSource: SOURCE })

		withReplace(host)

		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
			await Promise.resolve()
		})

		act(() => {
			emitPreviewItemRemoved(DOC.data.uuid)
		})
		clickSubfolders()

		expect(host.props.onItemsReplaced).toHaveBeenLastCalledWith([A, B], 0)
	})

	it("no subfolders toggle on photos, recents, a shared root or while searching", async () => {
		// Photos opens the overlay with no source.
		renderOverlay([A, B], 0)
		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
		expect(bar()).not.toBeNull()
		expect(subfoldersToggle()).toBeNull()

		const base = { searchActive: false, hideDotFiles: true, dotFilenRoot: null, rootUuid: testUuid("root") }

		expect(listingSlideshowSource({ ...base, variant: "recents", pathUuids: [] })).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "favorites", pathUuids: [] })).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "links", pathUuids: [] })).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "trash", pathUuids: [] })).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "sharedIn", pathUuids: [] })).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "sharedOut", pathUuids: [] })).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "drive", pathUuids: [testUuid("d")], searchActive: true })).toBeUndefined()
		expect(
			listingSlideshowSource({ ...base, variant: "sharedIn", pathUuids: [testUuid("s"), testUuid("t")], searchActive: true })
		).toBeUndefined()
		expect(listingSlideshowSource({ ...base, variant: "sharedIn", pathUuids: [testUuid("s"), testUuid("t")] })).toEqual({
			kind: "shared",
			variant: "sharedIn",
			uuid: testUuid("t"),
			path: [testUuid("s"), testUuid("t")],
			hideDotFiles: true
		})
	})

	it("the My Drive root offers subfolders", async () => {
		const source = listingSlideshowSource({
			variant: "drive",
			pathUuids: [],
			searchActive: false,
			hideDotFiles: false,
			dotFilenRoot: testUuid("root"),
			rootUuid: testUuid("root")
		})

		expect(source).toEqual({ kind: "owned", uuid: testUuid("root"), hideDotFiles: false, dotFilenRoot: testUuid("root") })

		if (source === undefined) {
			return
		}

		const host = renderOverlay([A, B], 0, { slideshowSource: source })

		withReplace(host)
		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
		expect(subfoldersToggle()).not.toBeNull()
	})

	it("s starts it, but not while a video has focus", async () => {
		renderOverlay([A, B], 0)

		await screen.findByRole("button", { name: /^Slideshow/ })
		fireEvent.keyDown(screen.getByTestId("video"), withCode({ key: "s" }))
		expect(bar()).toBeNull()

		fireEvent.keyDown(popup(), withCode({ key: "s" }))
		expect(bar()).not.toBeNull()
	})

	it("Escape while running ends the slideshow and keeps the preview open", async () => {
		const host = renderOverlay([A, B], 0)

		fireEvent.click(await screen.findByRole("button", { name: /^Slideshow/ }))
		expect(bar()).not.toBeNull()

		fireEvent.keyDown(popup(), withCode({ key: "Escape" }))

		expect(bar()).toBeNull()
		expect(host.props.onClose).not.toHaveBeenCalled()
		expect(startButton()).not.toBeNull()
	})
})
