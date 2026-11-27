// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useContext, useEffect, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import type { DirPublicInfo, DirPublicLink, File as SdkFile, LinkedDir, LinkedDirsAndFiles, LinkedFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"

// A directory link's opened file pages through the level's files (‹ › and the arrows) and runs a slideshow over them,
// with the link's subdirectories on request. A single file's link has no pager.

interface Tree {
	items: DriveItem[]
	dirs: ReadonlyMap<string, LinkedDir>
}

const { tree, linkedFile, zoom, listings, searchClose } = vi.hoisted(() => ({
	tree: { fetch: vi.fn<(source: unknown, signal: AbortSignal) => Promise<Tree>>() },
	searchClose: vi.fn(() => Promise.resolve()),
	// The listing by level uuid, where a test sets one.
	listings: { byLevel: new Map<string, unknown>(), pending: new Set<string>() },
	linkedFile: { current: undefined as LinkedFile | undefined },
	zoom: {
		keys: (event: KeyboardEvent): void => {
			if (event.key.startsWith("Arrow")) {
				event.preventDefault()
			}
		}
	}
}))

vi.mock("@/features/publicLinks/queries/publicLink", () => ({
	useLinkSaveable: () => false,
	usePublicDirListing: ({ levelUuid }: { levelUuid: string | null }) =>
		levelUuid === null || listings.pending.has(levelUuid)
			? { status: "pending", data: undefined, refetch: vi.fn() }
			: { status: "success", data: listings.byLevel.get(levelUuid) ?? LISTING, refetch: vi.fn() },
	usePublicDirSize: () => ({ data: undefined }),
	usePublicVisitorSignedIn: () => ({ data: false }),
	usePublicViewModeQuery: () => ({ data: "list", refetch: () => Promise.resolve() }),
	usePublicFile: () => ({ status: "success", data: linkedFile.current, error: null, refetch: vi.fn() })
}))
// A search's results: the level's files, in the level itself.
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		searchLinkedOpen: () => Promise.resolve(),
		searchLinkedRange: () => Promise.resolve({ total: LISTING.files.length, hits: LISTING.files.map(item => ({ item, trail: [] })) }),
		searchLinkedClose: searchClose
	}
}))
vi.mock("@/features/publicLinks/lib/download", () => ({
	startAnonDirZipDownload: vi.fn(),
	startAnonFileDownload: vi.fn(),
	startAnonItemsZipDownload: vi.fn()
}))
vi.mock("@/features/publicLinks/components/saveToDrive", () => ({ SaveToDriveButton: () => null, SaveToDriveDialog: () => null }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/media/wakeLock", () => ({ createScreenWakeLock: () => ({ set: vi.fn(), dispose: vi.fn() }) }))
vi.mock("@/features/preview/lib/previewPrefetch", () => ({ prefetchPreviewImage: () => null }))
vi.mock("@/features/drive/lib/thumbnails", async () => ({
	...(await vi.importActual<typeof import("@/features/drive/lib/thumbnails")>("@/features/drive/lib/thumbnails")),
	peekThumbnailUrl: () => null
}))
vi.mock("@/features/preview/lib/slideshowTree", () => ({ fetchLinkedSlideshowTree: tree.fetch }))
vi.mock("@/features/preview/components/contentSniffGate", () => ({ ContentSniffGate: ({ render }: { render: () => unknown }) => render() }))

// The viewer: its file's name, the files beside it, a video element, and a zoom that takes the arrows first as
// ZoomableImage does.
vi.mock("@/features/preview/components/readOnlyPreviewBody", () => ({
	ReadOnlyPreviewBody: ({ alt }: { alt: string }) =>
		createElement(
			"div",
			null,
			createElement("p", null, `viewer ${alt}`),
			createElement(SiblingNames),
			createElement(ReportShown),
			createElement("video", { "data-testid": "video", tabIndex: 0 }),
			createElement(
				"button",
				{
					type: "button",
					onClick: () => {
						document.addEventListener("keydown", zoom.keys, true)
					}
				},
				"zoom in"
			)
		)
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem } from "@/features/drive/lib/item"
import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { FileLinkView } from "@/features/publicLinks/components/fileLinkView"
import { setSlideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import { PreviewAccessModeProvider, PreviewSiblingsProvider, usePreviewSiblings } from "@/features/preview/lib/accessMode"
import { ImageShownContext } from "@/features/preview/lib/imageDisplay"
import { usePreviewSubtitles } from "@/features/preview/hooks/usePreviewSubtitles"
import { driveItemName } from "@filen/shared"
import { mockLinkedFile } from "@/tests/fixtures/sdk"
import { withCode } from "@/tests/support/keys"
import { mockViewportHeight } from "@/tests/support/viewport"
import { testUuid } from "@/tests/support/uuid"

registerAllActions()

const ROOT_UUID = testUuid("root")

function makeFile(name: string, mime: string, parent: SdkFile["parent"] = ROOT_UUID, size = 1024n): SdkFile {
	return {
		uuid: testUuid(name.replace(/\W/g, "")),
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime, size, key: "k", version: 2, modified: 1n } },
		parent,
		size,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

const LISTING = {
	dirs: [
		{
			inner: {
				uuid: testUuid("sub"),
				parent: ROOT_UUID,
				color: "default",
				timestamp: 0n,
				favorited: false,
				meta: { type: "decoded", data: { name: "Sub" } }
			},
			linkedTag: true
		}
	],
	files: [
		makeFile("a.jpg", "image/jpeg"),
		makeFile("b.png", "image/png"),
		makeFile("doc.pdf", "application/pdf"),
		makeFile("song.mp3", "audio/mpeg")
	]
}
const SUB_DIR = LISTING.dirs[0] as LinkedDir
const DEEP = narrowItem(makeFile("deep.jpg", "image/jpeg", testUuid("sub")))
const DEEP_VIDEO = makeFile("deep.mp4", "video/mp4", testUuid("sub"))
const DEEP_LISTING: LinkedDirsAndFiles = { dirs: [], files: [DEEP_VIDEO, makeFile("deep.srt", "text/plain", testUuid("sub"))] }
const A_JPG = narrowItem(makeFile("a.jpg", "image/jpeg"))
const B_PNG = narrowItem(makeFile("b.png", "image/png"))

// A viewer puts its picture on screen as it mounts.
function ReportShown() {
	const shown = useContext(ImageShownContext)

	useEffect(() => {
		shown?.({ width: 1, height: 1 })
	}, [shown])

	return null
}

function SiblingNames() {
	const siblings = usePreviewSiblings()

	return createElement("p", null, `siblings ${(siblings ?? []).map(driveItemName).join(",")}`)
}

function treeOf(...items: DriveItem[]): Tree {
	return { items, dirs: new Map([[SUB_DIR.inner.uuid, SUB_DIR]]) }
}

// A fetch that resolves when the test says so.
function deferredTree(): { resolve: (value: Tree) => void; signal: () => AbortSignal | undefined } {
	let resolve: (value: Tree) => void = () => undefined

	tree.fetch.mockImplementationOnce(
		() =>
			new Promise<Tree>(done => {
				resolve = done
			})
	)

	return {
		resolve: value => {
			resolve(value)
		},
		signal: () => tree.fetch.mock.calls[0]?.[1]
	}
}
const INFO = { root: { inner: { uuid: ROOT_UUID, meta: { type: "decoded", data: { name: "Photos" } } } } } as unknown as DirPublicInfo
const LINK = { enableDownload: true, linkKey: "key", password: undefined } as unknown as DirPublicLink

function openFile(name: string): void {
	render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
	fireEvent.doubleClick(screen.getByRole("option", { name: new RegExp(`^${name}`) }))
}

function viewer(): string {
	return screen.getByText(/^viewer /).textContent
}

function key(target: Element | Document, init: { key: string; altKey?: boolean }): void {
	fireEvent.keyDown(target, withCode(init))
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

function setFullscreen(element: Element | null): void {
	Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element, writable: true })
}

const requestFullscreen = vi.fn(() => {
	setFullscreen(document.documentElement)

	return Promise.resolve()
})
const exitFullscreen = vi.fn(() => {
	setFullscreen(null)

	return Promise.resolve()
})

beforeEach(() => {
	mockViewportHeight(element => element.getAttribute("role") === "listbox", 800)
	tree.fetch.mockReset()
	searchClose.mockClear()
	listings.byLevel.clear()
	listings.pending.clear()
	setFullscreen(null)
	Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true })
	requestFullscreen.mockClear()
	exitFullscreen.mockClear()
	document.documentElement.requestFullscreen = requestFullscreen
	document.exitFullscreen = exitFullscreen
	setSlideshowPrefs({ subfolders: false, shuffle: false })
})

afterEach(() => {
	document.removeEventListener("keydown", zoom.keys, true)
	cleanup()
	vi.useRealTimers()
	Reflect.deleteProperty(document, "fullscreenElement")
	Reflect.deleteProperty(document, "fullscreenEnabled")
})

describe("a public directory link's pager", () => {
	it("the hero pages with ‹ › and the arrow keys", () => {
		openFile("a.jpg")

		expect(viewer()).toBe("viewer a.jpg")
		expect(screen.getByRole("button", { name: /^Previous file/ }).hasAttribute("disabled")).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: /^Next file/ }))
		expect(viewer()).toBe("viewer b.png")

		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer doc.pdf")

		// The audio file is not a stop; the end clamps.
		expect(screen.getByRole("button", { name: /^Next file/ }).hasAttribute("disabled")).toBe(true)
		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer doc.pdf")

		key(document.body, { key: "ArrowLeft" })
		expect(viewer()).toBe("viewer b.png")
	})

	it("arrow keys inside a video's controls or on a zoomed image do not page", () => {
		openFile("a.jpg")

		key(screen.getByTestId("video"), { key: "ArrowRight" })
		expect(viewer()).toBe("viewer a.jpg")

		fireEvent.click(screen.getByRole("button", { name: "zoom in" }))
		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer a.jpg")
	})

	it("a file the pager does not step onto opens alone", () => {
		openFile("song.mp3")

		expect(screen.queryByRole("button", { name: /^Next file/ })).toBeNull()
		expect(screen.queryByRole("button", { name: /^Slideshow/ })).toBeNull()
	})

	it("a single-file link shows no pager", () => {
		linkedFile.current = mockLinkedFile()
		render(createElement(FileLinkView, { uuid: testUuid("link"), linkKey: "key" }))

		expect(screen.queryByRole("button", { name: /^Next file/ })).toBeNull()
		expect(screen.queryByRole("button", { name: /^Previous file/ })).toBeNull()
		expect(screen.queryByRole("button", { name: /^Slideshow/ })).toBeNull()
	})

	it("▶ starts a slideshow over the visible files", () => {
		openFile("a.jpg")

		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))

		// The two images; the PDF and the audio file are no slides.
		expect(screen.getByText("1/2")).toBeDefined()
		// The header gives way to the bar.
		expect(screen.queryByRole("button", { name: /^Hide preview/ })).toBeNull()
		expect(screen.getByRole("button", { name: /^End slideshow/ })).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: /^End slideshow/ }))
		expect(screen.getByRole("button", { name: /^Slideshow/ })).toBeDefined()
		expect(viewer()).toBe("viewer a.jpg")
	})

	it("offers no slideshow on a file that is no slide", () => {
		openFile("doc.pdf")

		expect(viewer()).toBe("viewer doc.pdf")
		expect(screen.queryByRole("button", { name: /^Slideshow/ })).toBeNull()
		key(document.body, { key: "s" })
		expect(screen.queryByRole("button", { name: /^End slideshow/ })).toBeNull()
	})

	it("s starts it and Escape ends it without leaving the file", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1000)

		openFile("b.png")

		key(document.body, { key: "s" })
		expect(screen.getByRole("button", { name: /^End slideshow/ })).toBeDefined()

		key(document.body, { key: "Escape" })
		expect(screen.queryByRole("button", { name: /^End slideshow/ })).toBeNull()
		expect(viewer()).toBe("viewer b.png")

		// Then, past the Escape the browser may also pass on as it leaves full screen, Escape leaves the file for the list.
		now.mockReturnValue(2500)
		key(document.body, { key: "Escape" })
		expect(screen.queryByText(/^viewer /)).toBeNull()
		expect(screen.getByRole("option", { name: /^a\.jpg/ })).toBeDefined()
	})

	it("subfolders lists the link level recursively", async () => {
		const [a] = LISTING.files

		if (a === undefined) {
			throw new Error("a.jpg expected")
		}

		tree.fetch.mockResolvedValue(treeOf(narrowItem(a), DEEP))
		openFile("a.jpg")

		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		await flush()

		expect(tree.fetch).toHaveBeenCalledWith({ kind: "linked", dir: INFO.root, link: LINK }, expect.any(AbortSignal))
		expect(viewer()).toBe("viewer a.jpg")
		expect(screen.getByText("1/2")).toBeDefined()

		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer deep.jpg")

		// Ending it brings the level's list back, at the file it started from (deep.jpg is not in it).
		fireEvent.click(screen.getByRole("button", { name: /^End slideshow/ }))
		expect(viewer()).toBe("viewer a.jpg")
		expect(screen.getByRole("button", { name: /^Next file/ }).hasAttribute("disabled")).toBe(false)
	})

	it("the link's listing a slideshow's subdirectories held is freed as the page goes", async () => {
		tree.fetch.mockResolvedValue(treeOf(A_JPG, B_PNG, DEEP))
		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		await flush()

		expect(searchClose).not.toHaveBeenCalled()

		cleanup()

		expect(searchClose).toHaveBeenCalledTimes(1)
	})

	it("offers no subdirectories over a search's results", async () => {
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "." } })
		fireEvent.doubleClick(await screen.findByRole("option", { name: /^a\.jpg/ }))

		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))

		expect(screen.queryByRole("button", { name: /^Include subdirectories/ })).toBeNull()
	})
	it("Home and End go to the first and last file", () => {
		openFile("b.png")

		key(document.body, { key: "End" })
		expect(viewer()).toBe("viewer doc.pdf")

		key(document.body, { key: "Home" })
		expect(viewer()).toBe("viewer a.jpg")
	})

	it("an image too large to preview shows its card in a running show", () => {
		listings.byLevel.set(ROOT_UUID, {
			dirs: [],
			files: [makeFile("a.jpg", "image/jpeg"), makeFile("big.heic", "image/heic", ROOT_UUID, 600_000_000n)]
		})
		openFile("a.jpg")

		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		key(document.body, { key: "ArrowRight" })

		// Never read whole into memory: its card, under the slideshow's bar.
		expect(screen.queryByText(/^viewer /)).toBeNull()
		expect(screen.getByText("big.heic")).toBeDefined()
		expect(screen.getByRole("button", { name: /^End slideshow/ })).toBeDefined()
	})

	it("a subdirectories list that lands mid-show keeps the file on screen", async () => {
		const pending = deferredTree()

		setSlideshowPrefs({ subfolders: true })
		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))

		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer b.png")

		pending.resolve(treeOf(A_JPG, B_PNG, DEEP))
		await flush()

		expect(viewer()).toBe("viewer b.png")
		expect(screen.getByText("2/3")).toBeDefined()
	})

	it("subdirectories off returns to the level's list at the file on screen, else its first file", async () => {
		tree.fetch.mockResolvedValue(treeOf(A_JPG, B_PNG, DEEP))
		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))

		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		await flush()
		key(document.body, { key: "ArrowRight" })
		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		expect(viewer()).toBe("viewer b.png")
		expect(screen.getByText("2/2")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		await flush()
		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer deep.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		expect(viewer()).toBe("viewer a.jpg")
	})

	it("a subdirectories list still loading when the show ends never lands", async () => {
		const pending = deferredTree()

		setSlideshowPrefs({ subfolders: true })
		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		fireEvent.click(screen.getByRole("button", { name: /^End slideshow/ }))

		expect(pending.signal()?.aborted).toBe(true)

		pending.resolve(treeOf(A_JPG, DEEP))
		await flush()

		expect(viewer()).toBe("viewer a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Next file/ }))
		expect(viewer()).toBe("viewer b.png")
	})

	it("a video from a subdirectory finds the files beside it there", async () => {
		listings.byLevel.set(SUB_DIR.inner.uuid, DEEP_LISTING)
		tree.fetch.mockResolvedValue(treeOf(A_JPG, narrowItem(DEEP_VIDEO)))
		openFile("a.jpg")
		expect(screen.getByText(/^siblings /).textContent).toBe("siblings Sub,a.jpg,b.png,doc.pdf,song.mp3")

		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		await flush()
		key(document.body, { key: "ArrowRight" })

		expect(viewer()).toBe("viewer deep.mp4")
		expect(screen.getByText(/^siblings /).textContent).toBe("siblings deep.mp4,deep.srt")
	})

	it("an Escape just after leaving full screen ended the show stays on the file", async () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1000)

		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		await flush()

		// The browser's Escape: it leaves full screen, then the page may get the key too.
		act(() => {
			setFullscreen(null)
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		expect(screen.queryByRole("button", { name: /^End slideshow/ })).toBeNull()

		key(document.body, { key: "Escape" })
		expect(viewer()).toBe("viewer a.jpg")

		now.mockReturnValue(2500)
		key(document.body, { key: "Escape" })
		expect(screen.queryByText(/^viewer /)).toBeNull()
	})

	it("leaving the file mid-show leaves full screen", async () => {
		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		await flush()
		expect(requestFullscreen).toHaveBeenCalledTimes(1)

		key(document.body, { key: "ArrowUp", altKey: true })
		await flush()

		expect(screen.queryByText(/^viewer /)).toBeNull()
		expect(exitFullscreen).toHaveBeenCalledTimes(1)
	})
	it("a subdirectory's video plays while its directory is still listed, and is not skipped for it", async () => {
		listings.pending.add(SUB_DIR.inner.uuid)
		tree.fetch.mockResolvedValue(treeOf(A_JPG, narrowItem(DEEP_VIDEO)))
		openFile("a.jpg")
		fireEvent.click(screen.getByRole("button", { name: /^Slideshow/ }))
		fireEvent.click(screen.getByRole("button", { name: /^Include subdirectories/ }))
		await flush()

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		key(document.body, { key: "ArrowRight" })
		expect(viewer()).toBe("viewer deep.mp4")

		// Past the time an unshown slide gets: a video waits for its end.
		act(() => {
			vi.advanceTimersByTime(16_000)
		})
		expect(viewer()).toBe("viewer deep.mp4")
	})

	it("a video's subtitles come with a listing provided after it mounted", () => {
		let siblings: readonly DriveItem[] = []
		const video = narrowItem(DEEP_VIDEO)
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(PreviewAccessModeProvider, {
				mode: "anon",
				linkScope: "scope",
				children: createElement(PreviewSiblingsProvider, { siblings, children })
			})
		const { result, rerender } = renderHook(() => usePreviewSubtitles(video, null, null), { wrapper })

		expect(result.current.options).toEqual([])

		siblings = DEEP_LISTING.files.map(file => narrowItem(file))
		rerender()

		expect(result.current.options.map(option => option.id)).toEqual([`s:${testUuid("deepsrt")}`])
	})
})
