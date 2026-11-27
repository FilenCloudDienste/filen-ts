// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DirPublicInfo, DirPublicLink, File as SdkFile, LinkedDir } from "@filen/sdk-rs"
import type { DriveViewMode } from "@/features/drive/lib/preferences"
import { GRID_INSET, TILE_ROW_HEIGHT } from "@/features/drive/lib/gridLayout"
import { mockViewportHeight } from "@/tests/support/viewport"
import { withCode } from "@/tests/support/keys"
import "@/lib/i18n"

// The directory link's grid: drive's tiles with the list's selection and keys, one view choice per browser, and
// thumbnails, in the list's rows too, read through the public-link client, never the session's.

interface StoredViewMode {
	mode: DriveViewMode
	writes: DriveViewMode[]
}

const { stored, makeLinkedSdkThumbnailAnon, downloadLinkedFileBytesAnon } = vi.hoisted(() => {
	const initial: StoredViewMode = { mode: "list", writes: [] }

	return {
		stored: initial,
		makeLinkedSdkThumbnailAnon: vi.fn(),
		downloadLinkedFileBytesAnon: vi.fn<() => Promise<Uint8Array>>()
	}
})

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		makeLinkedSdkThumbnailAnon,
		downloadLinkedFileBytesAnon,
		cancelPreviewDownloadIfEarly: vi.fn(),
		// A search's one match: a photo in the subdirectory.
		searchLinkedOpen: () => Promise.resolve(),
		searchLinkedRange: () => Promise.resolve({ total: 1, hits: [{ item: DEEP_PHOTO, trail: [SUB] }] }),
		searchLinkedClose: () => Promise.resolve()
	}
}))
vi.mock("@/features/publicLinks/lib/viewMode", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/publicLinks/lib/viewMode")>()),
	getPublicViewMode: () => Promise.resolve(stored.mode),
	setPublicViewMode: (next: DriveViewMode) => {
		stored.mode = next
		stored.writes.push(next)

		return Promise.resolve()
	}
}))
vi.mock("@/features/publicLinks/queries/publicLink", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/publicLinks/queries/publicLink")>()),
	useLinkSaveable: () => false,
	usePublicDirListing: () => ({ status: "success", data: shown.listing, refetch: vi.fn() }),
	usePublicDirSize: () => ({ data: undefined }),
	usePublicVisitorSignedIn: () => ({ data: false })
}))
vi.mock("@/features/publicLinks/components/fileHero", () => ({
	FileHero: ({ onBack }: { onBack: () => void }) => createElement("button", { type: "button", onClick: onBack }, "file hero")
}))

import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { linkThumbnailSource } from "@/features/publicLinks/lib/thumbnails"
import { linkFingerprint } from "@/features/publicLinks/lib/queryKey.logic"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

const ROOT_UUID = "d1000000-0000-0000-0000-000000000000"

function makeFile(uuid: `${string}-${string}-${string}-${string}`, name: string, mime: string, canMakeThumbnail: boolean): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime, size: 1024n, key: "k", version: 2, modified: 1n } },
		parent: ROOT_UUID,
		size: 1024n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail
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
const PHOTO = makeFile("f1000000-0000-0000-0000-000000000000", "a-photo.jpg", "image/jpeg", true)
const PDF = makeFile("f2000000-0000-0000-0000-000000000000", "b-paper.pdf", "application/pdf", false)
const TEXT = makeFile("f3000000-0000-0000-0000-000000000000", "c-notes.txt", "text/plain", false)
const MORE = makeFile("f4000000-0000-0000-0000-000000000000", "d-more.txt", "text/plain", false)
const LISTING = { dirs: [SUB], files: [PHOTO, PDF, TEXT, MORE] }
const DEEP_PHOTO = { ...makeFile("f5000000-0000-0000-0000-000000000000", "e-deep.jpg", "image/jpeg", true), parent: SUB.inner.uuid }
// Thirty files: ten rows of three tiles, taller than the 800px view.
const LONG_LISTING = {
	dirs: [],
	files: Array.from({ length: 30 }, (_, index) => {
		const n = String(index).padStart(2, "0")

		return makeFile(`f9${n}0000-0000-0000-0000-000000000000`, `long-${n}.txt`, "text/plain", false)
	})
}
const shown = { listing: LISTING }
const INFO = { root: { inner: { uuid: ROOT_UUID, meta: { type: "decoded", data: { name: "Photos" } } } } } as unknown as DirPublicInfo
const LINK = { enableDownload: true, linkKey: "key", password: undefined } as unknown as DirPublicLink

// jsdom lays nothing out: the listbox reports 600px of width, three tiles a row.
class WideResizeObserver {
	private readonly callback: ResizeObserverCallback

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback
	}

	observe(target: Element): void {
		const width = target.getAttribute("role") === "listbox" ? 600 : 0

		this.callback([{ target, contentRect: { width, height: 800 } } as unknown as ResizeObserverEntry], this)
	}

	unobserve(): void {
		// Nothing to stop.
	}

	disconnect(): void {
		// Nothing to stop.
	}
}

function renderBrowser(): void {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

	render(createElement(QueryClientProvider, { client }, createElement(DirectoryBrowser, { info: INFO, link: LINK })))
}

function option(name: string): HTMLElement {
	return screen.getByRole("option", { name: new RegExp(`^${name}`) })
}

function press(element: HTMLElement, key: string): void {
	element.focus()
	fireEvent.keyDown(element, withCode({ key }))
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal("ResizeObserver", WideResizeObserver)
	vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:thumb", revokeObjectURL: () => undefined }))
	mockViewportHeight(element => element.getAttribute("role") === "listbox", 800)
	stored.mode = "list"
	stored.writes = []
	shown.listing = LISTING
	// The service's url cache outlives a test: each starts with the photo's thumbnail not made yet.
	invalidateThumbnail(PHOTO.uuid, linkThumbnailSource(linkFingerprint(LINK)).deps)
	invalidateThumbnail(PDF.uuid, linkThumbnailSource(linkFingerprint(LINK)).deps)
	invalidateThumbnail(DEEP_PHOTO.uuid, linkThumbnailSource(linkFingerprint(LINK)).deps)
	downloadLinkedFileBytesAnon.mockRejectedValue(new Error("network"))
	makeLinkedSdkThumbnailAnon.mockResolvedValue({ type: "thumbnail", bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 })
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe("DirectoryBrowser — the grid", () => {
	it("switches the listing to tiles from the Display menu and remembers it for this browser", async () => {
		renderBrowser()

		expect(await screen.findByRole("button", { name: /^Name/ })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Display" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Grid view" }))

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /^Name/ })).toBeNull()
		})
		expect(stored.writes).toEqual(["grid"])
		expect(screen.getAllByRole("option")).toHaveLength(5)
		// The grid has no columns to sort by: the sort menu shows at every width.
		expect(screen.getByRole("checkbox", { name: "Select all" })).toBeTruthy()
	})

	it("opens in the grid a visitor chose before", async () => {
		stored.mode = "grid"
		renderBrowser()

		await waitFor(() => {
			expect(screen.getByRole("listbox").style.padding).toBe("12px")
		})
		expect(screen.queryByRole("button", { name: /^Name/ })).toBeNull()
	})

	it("moves by tile with Left and Right and by row with Up and Down, Shift extending the selection", async () => {
		stored.mode = "grid"
		renderBrowser()

		await waitFor(() => {
			expect(screen.getByRole("listbox").style.padding).toBe("12px")
		})

		press(option("Sub"), "ArrowRight")
		expect(option("a-photo.jpg").tabIndex).toBe(0)

		press(option("a-photo.jpg"), "ArrowDown")
		expect(option("d-more.txt").tabIndex).toBe(0)

		press(option("d-more.txt"), "ArrowLeft")
		expect(option("c-notes.txt").tabIndex).toBe(0)

		// A row up from the fourth tile is the first: the range runs from there back to where the keys left the anchor.
		fireEvent.keyDown(option("c-notes.txt"), withCode({ key: "ArrowUp", shiftKey: true }))
		expect(option("Sub").tabIndex).toBe(0)
		expect(
			screen
				.getAllByRole("option")
				.filter(element => element.getAttribute("aria-selected") === "true")
				.map(element => element.textContent)
		).toEqual(["Sub", "a-photo.jpg", "b-paper.pdf", "c-notes.txt"])
	})

	it("selects a tile on a click and toggles one from its own box", async () => {
		stored.mode = "grid"
		renderBrowser()

		await waitFor(() => {
			expect(screen.getByRole("listbox").style.padding).toBe("12px")
		})

		fireEvent.click(option("Sub"), { detail: 1 })

		const box = option("c-notes.txt").querySelector("span[aria-hidden]")

		if (box === null) {
			throw new Error("c-notes.txt has no selection box")
		}

		fireEvent.click(box)
		expect(option("Sub").getAttribute("aria-selected")).toBe("true")
		expect(option("c-notes.txt").getAttribute("aria-selected")).toBe("true")
		expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeTruthy()
	})

	it("comes back from a file opened several rows down scrolled where it was, focused on its tile", async () => {
		stored.mode = "grid"
		shown.listing = LONG_LISTING
		// jsdom scrolls nothing: the virtualizer's scrolls land on scrollTop, under the ten rows' height.
		Object.defineProperty(HTMLElement.prototype, "scrollTo", {
			configurable: true,
			value(this: HTMLElement, options: ScrollToOptions) {
				this.scrollTop = options.top ?? this.scrollTop
			}
		})
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return this.getAttribute("role") === "listbox" ? 10 * TILE_ROW_HEIGHT + 2 * GRID_INSET : 0
			}
		})
		onTestFinished(() => {
			Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
			Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight")
		})
		renderBrowser()

		await waitFor(() => {
			expect(screen.getByRole("listbox").style.padding).toBe("12px")
		})

		// Row seven at the top of the view; its second tile opens.
		const offset = 6 * TILE_ROW_HEIGHT

		screen.getByRole("listbox").scrollTop = offset
		fireEvent.scroll(screen.getByRole("listbox"))
		fireEvent.doubleClick(await screen.findByRole("option", { name: /^long-19\.txt/ }))
		fireEvent.click(screen.getByRole("button", { name: "file hero" }))

		await waitFor(() => {
			expect(document.activeElement).toBe(option("long-19\\.txt"))
		})
		expect(screen.getByRole("listbox").scrollTop).toBe(offset)
	})

	it("thumbnails an image and a pdf through the public-link client and asks nothing for a kind with none", async () => {
		stored.mode = "grid"
		renderBrowser()

		await waitFor(() => {
			expect(option("a-photo.jpg").querySelector("img")?.getAttribute("src")).toBe("blob:thumb")
		})
		expect(makeLinkedSdkThumbnailAnon).toHaveBeenCalledTimes(1)
		expect(makeLinkedSdkThumbnailAnon.mock.calls[0]?.[0]).toMatchObject({ uuid: PHOTO.uuid })
		// A small pdf is read whole, through the same client; this one's read fails and it keeps its icon.
		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalled()
		})
		expect((downloadLinkedFileBytesAnon.mock.calls as unknown as [{ uuid: string }][]).every(([file]) => file.uuid === PDF.uuid)).toBe(
			true
		)
		expect(option("b-paper.pdf").querySelector("img")?.getAttribute("src")).not.toBe("blob:thumb")
		expect(option("c-notes.txt").querySelector("img")?.getAttribute("src")).not.toBe("blob:thumb")
	})

	it("shows the thumbnail in a list row as drive's row does", async () => {
		renderBrowser()

		await waitFor(() => {
			expect(option("a-photo.jpg").querySelector("img")?.getAttribute("src")).toBe("blob:thumb")
		})
		expect(option("a-photo.jpg").querySelector("img")?.className.split(" ")).toEqual(
			expect.arrayContaining(["size-6", "shrink-0", "rounded-md", "object-cover"])
		)
		expect(makeLinkedSdkThumbnailAnon).toHaveBeenCalledTimes(1)
	})

	it("thumbnails a search's result from a subdirectory through the public-link client", async () => {
		stored.mode = "grid"
		renderBrowser()

		await screen.findByRole("button", { name: "Display" })
		fireEvent.change(screen.getByRole("searchbox", { name: "Search this directory" }), { target: { value: "deep" } })

		await waitFor(() => {
			expect(option("e-deep.jpg").querySelector("img")?.getAttribute("src")).toBe("blob:thumb")
		})
		expect(makeLinkedSdkThumbnailAnon.mock.calls.some(call => (call[0] as { uuid: string }).uuid === DEEP_PHOTO.uuid)).toBe(true)
		expect(option("e-deep.jpg").textContent).toContain("Sub")
	})
})
