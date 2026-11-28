// @vitest-environment jsdom

// The listing's details panel: shown only while something is selected, a close the device remembers, a sheet below
// the breakpoint that only its toggle or Info opens, remote reads only once a selection holds still (and a photo's
// header read cancelled when it does not), and a selection's totals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useState, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Dir, DirSizeResponse, File } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"
import { testUuid } from "@/tests/support/uuid"
import "@/lib/i18n"

const { viewport, stored, sdk } = vi.hoisted(() => ({
	viewport: { wide: true },
	stored: new Map<string, unknown>(),
	sdk: {
		getItemInfo: vi.fn((_item: unknown) => Promise.resolve({ path: "Photos/", ancestors: [] })),
		getDirSize: vi.fn<(dir: unknown) => Promise<DirSizeResponse>>(),
		getFileLinkStatus: vi.fn(() => Promise.resolve(null)),
		getDirectoryLinkStatus: vi.fn(() => Promise.resolve(null)),
		listSharedOutRoot: vi.fn(() => Promise.resolve({ dirs: [], files: [] })),
		readFileBytesRange: vi.fn((..._args: unknown[]) => new Promise<Uint8Array>(() => undefined)),
		cancelPreviewDownload: vi.fn((_token: string) => Promise.resolve())
	}
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([])
}))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/features/shell/lib/sidePanelLayout", () => ({
	isSidePanelNarrow: () => !viewport.wide,
	subscribeToSidePanelBreakpoint: () => () => undefined,
	useIsSidePanelNarrow: () => !viewport.wide
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/thumbnails", () => ({ invalidateThumbnail: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
	useNavigate: () => vi.fn(),
	useRouter: () => ({ state: { location: { pathname: "/drive" } } }),
	useRouterState: () => ""
}))

const { queryClient } = await import("@/queries/client")
const { queryClientWrapper } = await import("@/tests/testQueryClient")
const { narrowItem } = await import("@/features/drive/lib/item")
const { directorySizeQueryKey } = await import("@/features/drive/queries/drive")
const { DriveDetailsHost, DriveDetailsToggle } = await import("@/features/drive/components/detailsPanel")
const { driveDetailsPanel, loadDriveDetailsPanelOpen, openDriveDetails } = await import("@/features/drive/store/useDriveDetailsPanel")
const { useDriveStore } = await import("@/features/drive/store/useDriveStore")
const { DETAILS_SETTLE_MS } = await import("@/features/drive/components/itemDetails.logic")
const { SidePanelSlotContext } = await import("@/features/shell/lib/sidePanelSlot")
const { registerAllActions } = await import("@/lib/keymap/actions")

type DriveItem = ReturnType<typeof narrowItem>

registerAllActions()

function file(label: string, size: number, name = `${label}.pdf`, mime = "application/pdf"): DriveItem {
	const raw: File = {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: BigInt(size),
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: BigInt(size), key: "k", version: 2 } }
	}

	return narrowItem(raw)
}

function directory(label: string): DriveItem {
	const raw: Dir = {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}

	return narrowItem(raw)
}

// The listing's mount, with the shell's side-panel slot beside it and the selection bar's toggle.
function Listing({ items, toggle = false, suspended = false }: { items: DriveItem[]; toggle?: boolean; suspended?: boolean }) {
	const [slot, setSlot] = useState<HTMLDivElement | null>(null)

	return (
		<SidePanelSlotContext value={slot}>
			{toggle ? <DriveDetailsToggle /> : null}
			<DriveDetailsHost
				items={items}
				variant="drive"
				suspended={suspended}
				onDialogAction={vi.fn()}
			/>
			<div ref={setSlot} />
		</SidePanelSlotContext>
	)
}

const wrapper = queryClientWrapper(queryClient)

function renderListing(items: DriveItem[], toggle = false) {
	return render(createElement(Listing, { items, toggle }), { wrapper })
}

function panel(): HTMLElement | null {
	return screen.queryByRole("complementary")
}

async function pastSettle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, DETAILS_SETTLE_MS + 50))
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	viewport.wide = true
	stored.clear()
	queryClient.clear()
	driveDetailsPanel.useStore.setState({ panelOpen: true, drawerKey: null, focusRequestedFor: null })
	useDriveStore.getState().clearSelectedItems()
})

afterEach(() => {
	cleanup()
})

describe("visibility", () => {
	it("is hidden while nothing is selected", () => {
		renderListing([])

		expect(panel()).toBeNull()
	})

	it("shows beside the listing once something is selected", async () => {
		const view = renderListing([])

		view.rerender(createElement(Listing, { items: [file("a", 10)] }))

		await waitFor(() => {
			expect(panel()).not.toBeNull()
		})
		expect(screen.getByText("a.pdf")).toBeTruthy()
	})

	it("remembers a close on this device: later selections keep it hidden until the toggle reopens it", async () => {
		const view = renderListing([file("a", 10)], true)

		await waitFor(() => {
			expect(panel()).not.toBeNull()
		})
		fireEvent.click(screen.getByRole("button", { name: "Close" }))

		expect(panel()).toBeNull()
		expect(stored.get("drive.detailsPanelOpen.v1")).toBe(false)

		view.rerender(createElement(Listing, { items: [file("b", 10)], toggle: true }))
		expect(panel()).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		await waitFor(() => {
			expect(panel()).not.toBeNull()
		})
		expect(stored.get("drive.detailsPanelOpen.v1")).toBe(true)
	})

	it("reads the stored choice at boot", async () => {
		stored.set("drive.detailsPanelOpen.v1", false)

		await loadDriveDetailsPanelOpen()

		expect(driveDetailsPanel.useStore.getState().panelOpen).toBe(false)
		renderListing([file("a", 10)])
		expect(panel()).toBeNull()
	})

	it("below the breakpoint, opens as a sheet from its toggle only", async () => {
		viewport.wide = false
		renderListing([file("a", 10)], true)

		expect(screen.queryByRole("dialog")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		await waitFor(() => {
			expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy()
		})
	})

	it("the listing's Info selects the item it was offered for and opens the panel", () => {
		const item = file("a", 10)

		driveDetailsPanel.useStore.setState({ panelOpen: false })
		openDriveDetails([item])

		expect(useDriveStore.getState().selectedItems).toEqual([item])
		expect(driveDetailsPanel.useStore.getState().panelOpen).toBe(true)
	})
})

describe("lazy reads", () => {
	it("reads only the selection that held still, never one passed over", async () => {
		const a = file("a", 10)
		const b = file("b", 10)
		const c = file("c", 10)
		const view = renderListing([a])

		await waitFor(() => {
			expect(sdk.getItemInfo).toHaveBeenCalledTimes(1)
		})

		view.rerender(createElement(Listing, { items: [b] }))
		view.rerender(createElement(Listing, { items: [c] }))
		await pastSettle()

		await waitFor(() => {
			expect(sdk.getItemInfo).toHaveBeenCalledTimes(2)
		})
		expect(sdk.getItemInfo.mock.calls.map(([item]) => item)).toEqual([a.data, c.data])
	})

	it("reads nothing while a dialog covers it, and once it is uncovered", async () => {
		const photo = file("photo", 5_000_000, "photo.jpg", "image/jpeg")
		const view = renderListing([])

		view.rerender(createElement(Listing, { items: [photo], suspended: true }))
		await pastSettle()

		expect(sdk.getItemInfo).not.toHaveBeenCalled()
		expect(sdk.readFileBytesRange).not.toHaveBeenCalled()

		view.rerender(createElement(Listing, { items: [photo] }))

		await waitFor(() => {
			expect(sdk.readFileBytesRange).toHaveBeenCalledTimes(1)
		})
		expect(sdk.getItemInfo).toHaveBeenCalledTimes(1)
	})

	it("reads a photo's header once, bounded, and cancels it when the selection moves on", async () => {
		const photo = file("photo", 5_000_000, "photo.jpg", "image/jpeg")
		const view = renderListing([photo])

		await waitFor(() => {
			expect(sdk.readFileBytesRange).toHaveBeenCalledTimes(1)
		})
		expect(sdk.readFileBytesRange.mock.calls[0]?.slice(1, 3)).toEqual([0, 128 * 1024])

		const token = sdk.readFileBytesRange.mock.calls[0]?.[3]

		view.rerender(createElement(Listing, { items: [file("other", 10)] }))

		await waitFor(() => {
			expect(sdk.cancelPreviewDownload).toHaveBeenCalledWith(token)
		})
	})
})

describe("several items", () => {
	it("counts them and totals the files with every directory size already known", async () => {
		const dir = directory("dir")

		queryClient.setQueryData(directorySizeQueryKey(dir.data.uuid), { size: 4096n, files: 1n, dirs: 0n })
		renderListing([file("a", 1024), file("b", 2048), dir])

		await waitFor(() => {
			expect(panel()).not.toBeNull()
		})
		expect(screen.getByText("3 items selected")).toBeTruthy()
		expect(screen.getByText(formatBytes(1024 + 2048 + 4096))).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Calculate" })).toBeNull()
		expect(sdk.getDirSize).not.toHaveBeenCalled()
	})

	it("reads an unknown directory size only on Calculate", async () => {
		const dir = directory("cold")

		sdk.getDirSize.mockResolvedValueOnce({ size: 1000n, files: 1n, dirs: 0n })
		renderListing([file("a", 24), dir])

		await waitFor(() => {
			expect(screen.getByText(`At least ${formatBytes(24)}`)).toBeTruthy()
		})
		await pastSettle()
		expect(sdk.getDirSize).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Calculate" }))

		await waitFor(() => {
			expect(screen.getByText(formatBytes(1024))).toBeTruthy()
		})
		expect(sdk.getDirSize).toHaveBeenCalledTimes(1)
	})
})
