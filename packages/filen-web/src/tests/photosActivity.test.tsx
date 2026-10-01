// @vitest-environment jsdom

// The photos surface runs drive's activities over its own selection: a bulk favorite straight from the
// bar, and a bulk trash handed off by its confirm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { setFavoritedPhotos, trashPhotos, toast } = vi.hoisted(() => ({
	setFavoritedPhotos: vi.fn(),
	trashPhotos: vi.fn(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() })
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/photos" }))
vi.mock("@/features/photos/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/photos/lib/actions")>()),
	setFavoritedPhotos,
	trashPhotos
}))
vi.mock("@/features/preview/components/previewOverlay", () => ({ PreviewOverlay: () => null }))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: (props: { children: ReactNode }) => props.children,
	TooltipTrigger: (props: { render: ReactNode }) => props.render,
	TooltipContent: () => null
}))

import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { PhotosBulkActionBar } from "@/features/photos/components/bulkActionBar"
import { usePhotosDialogHost, type PhotosDialogHost } from "@/features/photos/hooks/usePhotosDialogHost"

const ROOT = "root-0000-0000-0000-000000000000"

function photo(name: string): PhotoItem {
	const item = narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: ROOT as UuidStr,
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

const A = photo("a.jpg")
const B = photo("b.jpg")
const ERROR = { species: "plain", message: "no", label: "no" }

beforeEach(() => {
	vi.clearAllMocks()
	usePhotosStore.setState({ selectedItems: [A, B] })
})

afterEach(() => {
	cleanup()
})

describe("photos bulk favorite", () => {
	it("runs as an activity, leaving only what failed selected", async () => {
		setFavoritedPhotos.mockResolvedValueOnce({ succeeded: [A], failed: [{ item: B, error: ERROR }] })
		render(createElement(PhotosBulkActionBar, { rootUuid: ROOT, selectedItems: [A, B], onDialogAction: vi.fn() }))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Favorite" }))
			await Promise.resolve()
		})

		expect(setFavoritedPhotos).toHaveBeenCalledExactlyOnceWith(ROOT, [A, B], true, expect.any(Function))
		expect(toast).toHaveBeenCalledWith("Adding 2 items to favorites", expect.anything())
		expect(toast.error).toHaveBeenCalledExactlyOnceWith("Added 1 item to favorites, 1 failed", expect.anything())
		expect(usePhotosStore.getState().selectedItems).toEqual([B])
	})
})

describe("photos bulk trash", () => {
	it("closes the confirm at once and hands the trash to an activity", async () => {
		const host: { current: PhotosDialogHost | null } = { current: null }

		function Host() {
			host.current = usePhotosDialogHost({ rootUuid: ROOT, selectedItems: [A, B] })

			return host.current.renderActiveDialog()
		}

		let finish: (outcome: unknown) => void = () => undefined
		trashPhotos.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		render(createElement(Host))

		act(() => {
			host.current?.handleBulkDialogAction("trash")
		})
		fireEvent.click(screen.getByRole("button", { name: "Trash" }))

		expect(trashPhotos).toHaveBeenCalledExactlyOnceWith(ROOT, [A, B], expect.any(Function))
		expect(host.current?.isDialogOpen).toBe(false)
		expect(toast).toHaveBeenCalledWith("Moving 2 items to trash", expect.anything())

		await act(async () => {
			finish({ succeeded: [A, B], failed: [] })
			await Promise.resolve()
		})

		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Moved 2 items to trash", expect.anything())
		expect(usePhotosStore.getState().selectedItems).toEqual([])
	})
})
