// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import type { CompressFormat, File, UserInfo, UuidStr } from "@filen/sdk-rs"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"
import type { CompressJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import type { ItemDialogProps } from "@/features/drive/components/itemDialogs"
import type { PreviewOverlayProps } from "@/features/preview/components/previewOverlay"
import "@/lib/i18n"

// Photos compresses like drive, from its tile menus, its selection bar and the preview's menu: the presets
// and the options dialog name the archive after one photo, after the one directory all of them lie in
// (from what the photos listing already holds, without asking the SDK), or after Photos for a mix
// (owner decision). Originals a compress removes leave the photos selection.

const { sdk, kvGetJson, startCompressWithCard, captured } = vi.hoisted(() => ({
	sdk: { archiveFormatInfo: vi.fn<(formats: CompressFormat[]) => Promise<ArchiveFormatInfo[]>>() },
	kvGetJson: vi.fn<() => Promise<unknown>>(),
	startCompressWithCard: vi.fn<(request: Omit<CompressJobRequest, "id">, password: string | undefined) => string>(),
	captured: { itemDialog: [] as ItemDialogProps[], overlay: [] as PreviewOverlayProps[] }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson: vi.fn(() => Promise.resolve()) }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@/features/transfers/lib/archiveToast", () => ({ startCompressWithCard }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/photos", useNavigate: () => vi.fn() }))
vi.mock("@/features/drive/components/itemDialogs", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/components/itemDialogs")>()),
	ItemDialog: (props: ItemDialogProps) => {
		captured.itemDialog.push(props)

		return null
	}
}))
vi.mock("@/features/preview/components/previewOverlay", () => ({
	PreviewOverlay: (props: PreviewOverlayProps) => {
		captured.overlay.push(props)

		return null
	}
}))

import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { driveNamesQueryKey } from "@/features/drive/queries/drive"
import { photosListingQueryKey, type PhotosListing } from "@/features/photos/queries/photos"
import { PHOTOS_HIDDEN_ACTION_IDS, PHOTOS_HIDDEN_BULK_ACTION_IDS, photosParentNaming } from "@/features/photos/lib/itemActions"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { PhotosBulkActionBar } from "@/features/photos/components/bulkActionBar"
import { usePhotosDialogHost, type PhotosDialogHost } from "@/features/photos/hooks/usePhotosDialogHost"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { testUuid } from "@/tests/support/uuid"

const DRIVE_ROOT = testUuid("drive-root")
const PHOTOS_ROOT = testUuid("camera")
const ROME = testUuid("rome")
const PARIS = testUuid("paris")

function photo(name: string, parent: string): PhotoItem {
	const item = narrowItem({
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: parent as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime: "image/jpeg", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)

	if (item.type !== "file") {
		throw new Error("expected a file")
	}

	return item
}

const COLOSSEUM = photo("colosseum.jpg", ROME)
const FORUM = photo("forum.jpg", ROME)
const EIFFEL = photo("eiffel.jpg", PARIS)
const SUNSET = photo("sunset.jpg", PHOTOS_ROOT)
const DAWN = photo("dawn.jpg", PHOTOS_ROOT)

const EXTENSIONS: Record<CompressFormat["type"], string> = { zip: ".zip", sevenZ: ".7z", tar: ".tar.gz", single: ".gz" }

function compressRequest(): Omit<CompressJobRequest, "id"> | undefined {
	return startCompressWithCard.mock.calls[0]?.[0]
}

function entry(name: string): HTMLElement {
	return screen.getByRole("menuitem", { name })
}

function renderBar(selectedItems: PhotoItem[]) {
	const onDialogAction = vi.fn()

	render(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(PhotosBulkActionBar, { rootUuid: PHOTOS_ROOT, selectedItems, onDialogAction })
		)
	)

	return { onDialogAction }
}

async function openBarCompress(): Promise<void> {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Compress" }))
		await Promise.resolve()
	})
}

async function runPreset(label: string): Promise<void> {
	act(() => {
		fireEvent.click(entry(label))
	})

	await waitFor(() => {
		expect(startCompressWithCard).toHaveBeenCalledTimes(1)
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	queryClient.clear()
	captured.itemDialog.length = 0
	captured.overlay.length = 0
	onlineManager.setOnline(true)
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: DRIVE_ROOT })
	// What the grid's walk and the screen header already hold; nothing is asked for a name.
	queryClient.setQueryData<PhotosListing>(photosListingQueryKey(PHOTOS_ROOT), {
		photos: [COLOSSEUM, FORUM, EIFFEL, SUNSET, DAWN],
		folders: { [ROME]: "Italy 2023/Rome", [PARIS]: "Paris" }
	})
	queryClient.setQueryData<string | null>(driveNamesQueryKey("drive", PHOTOS_ROOT), "Camera")
	kvGetJson.mockResolvedValue(null)
	sdk.archiveFormatInfo.mockImplementation(formats =>
		Promise.resolve(
			formats.map(format => ({
				extension: EXTENSIONS[format.type],
				levels: { min: 1, max: 9, defaultLevel: 6 },
				maxLevel: 9,
				encoderMemory: 1024
			}))
		)
	)
	startCompressWithCard.mockReturnValue("job")
	usePhotosStore.setState({ selectedItems: [] })
	useDriveStore.setState({ selectedItems: [] })
})

afterEach(() => {
	cleanup()
	onlineManager.setOnline(true)
})

describe("photos hidden actions", () => {
	it("hide only Move and Extract, menus and selection bar alike", () => {
		expect([...PHOTOS_HIDDEN_ACTION_IDS]).toEqual(["move", "extract"])
		expect([...PHOTOS_HIDDEN_BULK_ACTION_IDS]).toEqual(["move", "extract"])
	})
})

describe("photosParentNaming", () => {
	it("names a directory after its listing path's last segment, the root after the header's name, a mix after Photos", () => {
		const naming = photosParentNaming(PHOTOS_ROOT, "Photos")

		expect(naming.nameOf?.(ROME)).toBe("Rome")
		expect(naming.nameOf?.(PARIS)).toBe("Paris")
		expect(naming.nameOf?.(PHOTOS_ROOT)).toBe("Camera")
		expect(naming.nameOf?.(testUuid("unknown"))).toBeUndefined()
		expect(naming.mixedFallback).toBe("Photos")
		expect(sdk.archiveFormatInfo).not.toHaveBeenCalled()
	})
})

describe("photos selection bar Compress", () => {
	it("names a preset archive of photos from different directories after Photos, in Cloud Drive", async () => {
		renderBar([COLOSSEUM, EIFFEL])

		await openBarCompress()
		await runPreset("ZIP (.zip)")

		expect(compressRequest()).toMatchObject({
			source: { kind: "items", items: [COLOSSEUM, EIFFEL] },
			destination: { uuid: null, name: "Cloud Drive" },
			name: "Photos.zip",
			dispose: null,
			itemCount: 2
		})
	})

	it("names it after the one directory all of them lie in, next to them", async () => {
		renderBar([COLOSSEUM, FORUM])

		await openBarCompress()
		await runPreset("7-Zip (.7z)")

		expect(compressRequest()).toMatchObject({ destination: { uuid: ROME, name: "Rome" }, name: "Rome.7z" })
	})

	it("names photos lying directly in the photos directory after it", async () => {
		renderBar([SUNSET, DAWN])

		await openBarCompress()
		await runPreset("Tarball (.tar.gz)")

		expect(compressRequest()).toMatchObject({ destination: { uuid: PHOTOS_ROOT, name: "Camera" }, name: "Camera.tar.gz" })
	})

	it("opens the options dialog from More options", async () => {
		const { onDialogAction } = renderBar([COLOSSEUM, EIFFEL])

		await openBarCompress()

		act(() => {
			fireEvent.click(entry("More options…"))
		})

		expect(onDialogAction).toHaveBeenCalledExactlyOnceWith("compress")
		expect(startCompressWithCard).not.toHaveBeenCalled()
	})

	it("is disabled offline", () => {
		onlineManager.setOnline(false)
		renderBar([COLOSSEUM, EIFFEL])

		expect(screen.getByRole("button", { name: "Compress" }).hasAttribute("disabled")).toBe(true)
	})

	it("offers no Extract", () => {
		renderBar([COLOSSEUM, EIFFEL])

		expect(screen.queryByRole("button", { name: "Extract" })).toBeNull()
	})
})

describe("photo tile menu Compress", () => {
	it("names one photo's preset archive after it, next to it in its directory", async () => {
		render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(
					DropdownMenu,
					{ defaultOpen: true },
					createElement(DropdownMenuTrigger, null, "menu"),
					createElement(DriveDropdownMenuContent, {
						item: EIFFEL,
						variant: "drive",
						hiddenActionIds: PHOTOS_HIDDEN_ACTION_IDS,
						compressParentNaming: photosParentNaming(PHOTOS_ROOT, "Photos"),
						onItemAction: vi.fn()
					})
				)
			)
		)

		const trigger = entry("Compress")

		await act(async () => {
			trigger.focus()
			fireEvent.keyDown(trigger, { key: "ArrowRight" })
			await Promise.resolve()
		})
		await runPreset("ZIP (.zip)")

		expect(compressRequest()).toMatchObject({ destination: { uuid: PARIS, name: "Paris" }, name: "eiffel.zip", itemCount: 1 })
	})
})

describe("photos dialog host Compress", () => {
	function renderHost(selectedItems: PhotoItem[]): { current: PhotosDialogHost | null } {
		const host: { current: PhotosDialogHost | null } = { current: null }

		function Host() {
			host.current = usePhotosDialogHost({ rootUuid: PHOTOS_ROOT, selectedItems })

			return host.current.renderActiveDialog()
		}

		render(createElement(Host))

		return host
	}

	it("opens the options dialog on a photo, with Photos' naming, pruning the photos selection (not drive's)", () => {
		usePhotosStore.setState({ selectedItems: [COLOSSEUM, EIFFEL] })
		useDriveStore.setState({ selectedItems: [COLOSSEUM] })

		const host = renderHost([COLOSSEUM, EIFFEL])

		act(() => {
			host.current?.handleItemAction("compress", COLOSSEUM)
		})

		const props = captured.itemDialog.at(-1)

		expect(props?.kind).toBe("compress")
		expect(props?.items).toEqual([COLOSSEUM])
		expect(props?.variant).toBe("drive")
		expect(props?.compressParentNaming?.mixedFallback).toBe("Photos")
		expect(props?.compressParentNaming?.nameOf?.(ROME)).toBe("Rome")

		act(() => {
			props?.onSourcesDisposing?.([COLOSSEUM.data.uuid])
		})

		expect(usePhotosStore.getState().selectedItems).toEqual([EIFFEL])
		expect(useDriveStore.getState().selectedItems).toEqual([COLOSSEUM])
	})

	it("opens the options dialog on the whole selection from the bar", () => {
		const host = renderHost([COLOSSEUM, EIFFEL])

		act(() => {
			host.current?.handleBulkDialogAction("compress")
		})

		expect(captured.itemDialog.at(-1)?.kind).toBe("compress")
		expect(captured.itemDialog.at(-1)?.items).toEqual([COLOSSEUM, EIFFEL])
	})

	it("gives the preview's header menu Compress with Photos' naming and selection", () => {
		usePhotosStore.setState({ selectedItems: [SUNSET, DAWN] })

		const host = renderHost([SUNSET, DAWN])

		act(() => {
			host.current?.openPreview([SUNSET, DAWN], 0)
		})

		const props = captured.overlay.at(-1)

		expect(props?.hiddenMenuActionIds?.has("compress")).toBe(false)
		expect(props?.compressParentNaming?.nameOf?.(PHOTOS_ROOT)).toBe("Camera")

		act(() => {
			props?.onSourcesDisposing?.([SUNSET.data.uuid])
		})

		expect(usePhotosStore.getState().selectedItems).toEqual([DAWN])
	})
})
