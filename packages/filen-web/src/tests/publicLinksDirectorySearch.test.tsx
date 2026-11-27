// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { DirPublicInfo, DirPublicLink, File as SdkFile, LinkedDir, ParentUuid } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import type { LinkedSearchRange, LinkedSearchRequest } from "@/workers/linkedSearch"
import { mockViewportHeight } from "@/tests/support/viewport"
import { testUuid } from "@/tests/support/uuid"
import "@/lib/i18n"

// The directory link's field searches the level's whole subtree: listed once in the worker (with progress), its matches
// listed with their paths, opened in place like the level's own entries.

type Progress = (loaded: number, total: number | null) => void

const { sdk, listingCalls } = vi.hoisted(() => ({
	sdk: {
		searchLinkedOpen: vi.fn<(dir: unknown, link: DirPublicLink, onProgress: Progress) => Promise<void>>(),
		searchLinkedRange: vi.fn<(request: LinkedSearchRequest) => Promise<LinkedSearchRange>>(),
		searchLinkedClose: vi.fn<() => Promise<void>>()
	},
	listingCalls: [] as (string | null)[]
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("comlink", async () => ({ ...(await vi.importActual<typeof import("comlink")>("comlink")), proxy: (value: unknown) => value }))
vi.mock("@/features/publicLinks/queries/publicLink", () => ({
	useLinkSaveable: () => false,
	usePublicDirListing: ({ levelUuid }: { levelUuid: string | null }) => {
		listingCalls.push(levelUuid)

		return levelUuid === null
			? { status: "pending", data: undefined, refetch: vi.fn() }
			: { status: "success", data: LISTING, refetch: vi.fn() }
	},
	usePublicDirSize: () => ({ data: undefined }),
	usePublicVisitorSignedIn: () => ({ data: false }),
	usePublicViewModeQuery: () => ({ data: "list", refetch: () => Promise.resolve() })
}))
vi.mock("@/features/publicLinks/lib/download", () => ({
	startAnonDirZipDownload: vi.fn(),
	startAnonFileDownload: vi.fn(),
	startAnonItemsZipDownload: vi.fn()
}))
vi.mock("@/features/publicLinks/components/saveToDrive", () => ({ SaveToDriveButton: () => null, SaveToDriveDialog: () => null }))
// The hero: its file's name and a next step.
vi.mock("@/features/publicLinks/components/fileHero", () => ({
	FileHero: ({
		item,
		pager,
		onBack
	}: {
		item: DriveItem
		pager?: { canNext: boolean; step: (delta: number) => void }
		onBack: () => void
	}) =>
		createElement(
			"div",
			null,
			createElement("p", null, `hero ${driveItemName(item)}`),
			pager?.canNext === true
				? createElement(
						"button",
						{
							type: "button",
							onClick: () => {
								pager.step(1)
							}
						},
						"next"
					)
				: null,
			createElement("button", { type: "button", onClick: onBack }, "back")
		)
}))

import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

const ROOT_UUID = testUuid("root")
const dirBase = { color: "default", timestamp: 0n, favorited: false } as const

function linkedDir(id: string, parent: ParentUuid, name: string): LinkedDir {
	return { inner: { uuid: testUuid(id), parent, meta: { type: "decoded", data: { name } }, ...dirBase }, linkedTag: true }
}

function makeFile(id: string, name: string, mime: string, parent: ParentUuid): SdkFile {
	return {
		uuid: testUuid(id),
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime, size: 1024n, key: "k", version: 2, modified: 1n } },
		parent,
		size: 1024n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

const PHOTOS = linkedDir("photos", ROOT_UUID, "Photos")
const TRIP = linkedDir("trip", PHOTOS.inner.uuid, "Trip")
const README = makeFile("readme", "readme.txt", "text/plain", ROOT_UUID)
const LISTING = { dirs: [PHOTOS], files: [README] }
const BEACH = makeFile("beach", "beach.jpg", "image/jpeg", TRIP.inner.uuid)
const BEACH2 = makeFile("beach2", "beach-2.jpg", "image/jpeg", PHOTOS.inner.uuid)
const RESULTS: LinkedSearchRange = {
	total: 3,
	hits: [
		{ item: TRIP, trail: [PHOTOS] },
		{ item: BEACH2, trail: [PHOTOS] },
		{ item: BEACH, trail: [PHOTOS, TRIP] }
	]
}
const INFO = { root: { inner: { uuid: ROOT_UUID, meta: { type: "decoded", data: { name: "Public" } } } } } as unknown as DirPublicInfo
const LINK = { enableDownload: true, linkKey: "key", password: { type: "none" } } as unknown as DirPublicLink

function field(): HTMLElement {
	return screen.getByRole("searchbox", { name: "Search this directory" })
}

function type(value: string): void {
	fireEvent.change(field(), { target: { value } })
}

function rowNames(): string[] {
	return screen.getAllByRole("option").map(element => element.querySelector(".flex-1")?.textContent ?? "")
}

function option(name: string): HTMLElement {
	return screen.getByRole("option", { name: new RegExp(`^${name}`) })
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve()
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	listingCalls.length = 0
	mockViewportHeight(element => element.getAttribute("role") === "listbox", 800)
	sdk.searchLinkedOpen.mockResolvedValue(undefined)
	sdk.searchLinkedRange.mockResolvedValue(RESULTS)
	sdk.searchLinkedClose.mockResolvedValue(undefined)
})

afterEach(() => {
	cleanup()
})

describe("DirectoryBrowser — the search", () => {
	it("does nothing for a blank query, and a page that never searched asks nothing to close", async () => {
		const view = render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))

		type("   ")
		await settle()

		expect(sdk.searchLinkedOpen).not.toHaveBeenCalled()
		expect(sdk.searchLinkedRange).not.toHaveBeenCalled()
		expect(rowNames()).toEqual(["Photos", "readme.txt"])

		view.unmount()

		expect(sdk.searchLinkedClose).not.toHaveBeenCalled()
	})

	it("lists the subtree on the first keystroke with its progress, then shows the matches with their paths", async () => {
		let land: () => void = () => undefined
		let report: Progress = () => undefined

		sdk.searchLinkedOpen.mockImplementationOnce(
			(_dir, _link, onProgress) =>
				new Promise(resolve => {
					report = onProgress
					land = resolve
				})
		)
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("b")

		expect(sdk.searchLinkedOpen).toHaveBeenCalledWith(INFO.root, LINK, expect.any(Function))
		expect(screen.getByText("Searching all subdirectories…")).toBeDefined()

		act(() => {
			report(50, 200)
		})

		expect(screen.getByRole("progressbar", { name: "Searching all subdirectories…" }).getAttribute("aria-valuenow")).toBe("25")

		await act(async () => {
			land()
			await Promise.resolve()
		})

		expect(sdk.searchLinkedRange).toHaveBeenCalledWith({
			dirUuid: ROOT_UUID,
			link: LINK,
			name: "b",
			sort: "nameAsc",
			start: 0,
			end: 1_000
		})
		expect(screen.queryByText("Searching all subdirectories…")).toBeNull()
		expect(rowNames()).toEqual(["Trip", "beach-2.jpg", "beach.jpg"])
		expect(within(option("beach.jpg")).getByText("Photos/Trip")).toBeDefined()
		expect(within(option("Trip")).getByText("Photos")).toBeDefined()
	})

	it("queries the held listing on later keystrokes and sorts, and returns to the listing when cleared", async () => {
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("b")
		await settle()
		type("be")
		await settle()

		expect(sdk.searchLinkedOpen).toHaveBeenCalledTimes(1)
		expect(sdk.searchLinkedRange).toHaveBeenLastCalledWith(expect.objectContaining({ name: "be", sort: "nameAsc" }))

		fireEvent.click(screen.getByRole("button", { name: /^Name/ }))
		await settle()

		expect(sdk.searchLinkedRange).toHaveBeenLastCalledWith(expect.objectContaining({ name: "be", sort: "nameDesc" }))

		type("")
		await settle()

		expect(rowNames()).toEqual(["Photos", "readme.txt"])
		expect(sdk.searchLinkedRange).toHaveBeenCalledTimes(3)
	})

	it("shows no path for a match in the directory searched itself", async () => {
		sdk.searchLinkedRange.mockResolvedValueOnce({ total: 1, hits: [{ item: README, trail: [] }] })
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("read")
		await settle()

		expect(option("readme.txt").textContent).not.toContain("/")
		expect(option("readme.txt").querySelectorAll("[title]")).toHaveLength(0)
	})

	it("waits for a listing under way above the directory searched instead of listing again", async () => {
		let land: () => void = () => undefined

		sdk.searchLinkedOpen.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					land = resolve
				})
		)
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("b")
		type("")
		fireEvent.doubleClick(option("Photos"))
		type("b")

		expect(screen.getByText("Searching all subdirectories…")).toBeDefined()

		await act(async () => {
			land()
			await Promise.resolve()
		})

		expect(sdk.searchLinkedOpen).toHaveBeenCalledTimes(1)
		expect(sdk.searchLinkedRange).toHaveBeenCalledTimes(1)
		expect(sdk.searchLinkedRange).toHaveBeenLastCalledWith(expect.objectContaining({ dirUuid: PHOTOS.inner.uuid }))
	})

	it("says how many match where more than the window shows", async () => {
		sdk.searchLinkedRange.mockResolvedValueOnce({ ...RESULTS, total: 1_500 })
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("b")
		await settle()

		expect(screen.getByText("Showing 3 of 1500")).toBeDefined()
	})

	it("opens a result file in the hero, its pager stepping over the results", async () => {
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("b")
		await settle()
		fireEvent.doubleClick(option("beach-2.jpg"))

		expect(screen.getByText("hero beach-2.jpg")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "next" }))

		expect(screen.getByText("hero beach.jpg")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "back" }))

		expect(rowNames()).toEqual(["Trip", "beach-2.jpg", "beach.jpg"])
	})

	it("opens a result directory down its trail, which ends the search", async () => {
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		type("trip")
		await settle()
		fireEvent.doubleClick(option("Trip"))

		expect(screen.getByRole("heading", { name: "Trip" })).toBeDefined()

		const crumbs = within(screen.getByRole("navigation", { name: "Location in the shared directory" }))

		expect(crumbs.getByRole("button", { name: "Public" })).toBeDefined()
		expect(crumbs.getByRole("button", { name: "Photos" })).toBeDefined()
		expect((field() as HTMLInputElement).value).toBe("")
		expect(listingCalls.at(-1)).toBe(TRIP.inner.uuid)
	})

	it("searches a directory below the listed one without listing again, and frees the listing as the page goes", async () => {
		const view = render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))

		type("trip")
		await settle()
		fireEvent.doubleClick(option("Trip"))
		type("b")
		await settle()

		expect(sdk.searchLinkedOpen).toHaveBeenCalledTimes(1)
		expect(sdk.searchLinkedRange).toHaveBeenLastCalledWith(expect.objectContaining({ dirUuid: TRIP.inner.uuid, name: "b" }))

		view.unmount()

		expect(sdk.searchLinkedClose).toHaveBeenCalledTimes(1)
	})
})
