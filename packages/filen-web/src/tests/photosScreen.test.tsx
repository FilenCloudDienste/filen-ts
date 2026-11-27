// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { PhotosLibraryView } from "@/features/photos/lib/library"
import type { PhotosTimelineResult } from "@/features/photos/queries/photos"

// The Photos screen's failure states: a library that could not be read is an error with a retry, never the
// "choose a directory" hero; a directory that could not be listed while others did says so above the timeline.

const { state, loadPhotosLibrary } = vi.hoisted(() => ({
	state: {
		library: null as unknown as PhotosLibraryView,
		timeline: null as unknown as PhotosTimelineResult
	},
	loadPhotosLibrary: vi.fn(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/features/photos/lib/library", () => ({
	usePhotosLibrary: () => state.library,
	loadPhotosLibrary,
	removePhotosRoot: vi.fn(() => Promise.resolve())
}))
vi.mock("@/features/photos/queries/photos", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/photos/queries/photos")>()),
	usePhotosTimeline: () => state.timeline
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/keymap/useAction", () => ({ OUTSIDE_OVERLAYS: {}, useAction: () => () => undefined }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: undefined }) }))
vi.mock("@/features/drive/queries/drive", () => ({ useDirectoryNamesQuery: () => ({ data: undefined }) }))
vi.mock("@/features/photos/hooks/usePhotosRootViews", () => ({ usePhotosRootViews: () => [] }))
vi.mock("@/features/photos/components/directoryChooserDialog", () => ({ DirectoryChooserDialog: () => null }))
vi.mock("@/features/photos/components/directoriesDialog", () => ({ PhotosDirectoriesDialog: () => null }))
vi.mock("@/features/photos/components/photoGrid", () => ({ PhotoGrid: () => <div data-testid="photo-grid" /> }))
vi.mock("@/features/photos/components/densityControls", () => ({ PhotosDensityControls: () => null }))

import { PhotosScreen } from "@/features/photos/screens/photos"
import { narrowItem } from "@/features/drive/lib/item"
import type { PhotoItem } from "@/features/photos/lib/captureSort"
import { testUuid } from "@/tests/support/uuid"

function photo(name: string): PhotoItem {
	const item = narrowItem({
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: testUuid("dir"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: `${name}.jpg`, mime: "image/jpeg", modified: 0n, size: 1_024n, key: "k", version: 2 } }
	})

	if (item.type !== "file") {
		throw new Error("not a file")
	}

	return item
}

function timeline(failures: PhotosTimelineResult["failures"], retry = vi.fn()): PhotosTimelineResult {
	return {
		timeline: { status: "success", listing: { photos: [photo("p")], folders: {} } },
		listedRoots: ["a", "b"],
		failures,
		loadingMore: false,
		retry
	}
}

beforeEach(() => {
	loadPhotosLibrary.mockClear()
	state.timeline = timeline([])
})

afterEach(() => {
	cleanup()
})

describe("the photos screen", () => {
	it("a library that could not be read shows the error with a retry, not the directory hero", () => {
		state.library = { roots: [], loaded: false, readOnly: false, loadFailure: { error: new Error("offline") } }

		render(<PhotosScreen />)

		expect(screen.getByTestId("listing-error")).toBeTruthy()
		expect(screen.queryByText("Choose directory")).toBeNull()

		const callsBefore = loadPhotosLibrary.mock.calls.length

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))
		expect(loadPhotosLibrary.mock.calls.length).toBe(callsBefore + 1)
	})

	it("a library read as empty shows the directory hero", () => {
		state.library = { roots: [], loaded: true, readOnly: false, loadFailure: null }

		render(<PhotosScreen />)

		expect(screen.getByText("Choose directory")).toBeTruthy()
		expect(screen.queryByTestId("listing-error")).toBeNull()
	})

	it("says how many directories could not be read above the timeline, with a retry", () => {
		const retry = vi.fn()

		state.library = { roots: ["a", "b"], loaded: true, readOnly: false, loadFailure: null }
		state.timeline = timeline([{ rootUuid: "b", error: new Error("boom"), held: false }], retry)

		render(<PhotosScreen />)

		const notice = screen.getByRole("status")

		expect(notice.textContent).toContain("1 directory could not be read")
		expect(screen.getByTestId("photo-grid")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))
		expect(retry).toHaveBeenCalledTimes(1)
	})

	it("shows the photos already listed while another directory still loads, and says so", () => {
		state.library = { roots: ["a", "b"], loaded: true, readOnly: false, loadFailure: null }
		state.timeline = { ...timeline([]), loadingMore: true }

		render(<PhotosScreen />)

		expect(screen.getByTestId("photo-grid")).toBeTruthy()
		expect(screen.getByRole("status", { name: "Loading more photos…" })).toBeTruthy()
	})

	it("no notice when the failed directory still shows what was read earlier", () => {
		state.library = { roots: ["a", "b"], loaded: true, readOnly: false, loadFailure: null }
		state.timeline = timeline([{ rootUuid: "b", error: new Error("boom"), held: true }])

		render(<PhotosScreen />)

		expect(screen.queryByRole("status")).toBeNull()
	})
})
