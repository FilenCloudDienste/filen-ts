// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

// A rename or favorite replaces a photo in the grid, never in the selection; the grid's bulk actions and
// its copy take the selection. The grid's collaborators are reduced to what it hands them.

interface NamedItem {
	data: { decryptedMeta?: { name?: string } | null }
}

const { dialogHostSelection } = vi.hoisted(() => ({ dialogHostSelection: { current: [] as NamedItem[] } }))

function names(items: readonly NamedItem[]): string {
	return items.map(item => item.data.decryptedMeta?.name ?? "").join("|")
}

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/photos/queries/preferences", () => ({ usePhotosGridDensityQuery: () => ({ data: undefined, refetch: vi.fn() }) }))
vi.mock("@/features/drive/hooks/useMarqueeSelection", () => ({ useMarqueeSelection: () => ({ rect: null, onPointerDown: vi.fn() }) }))
vi.mock("@/features/photos/components/photoTile", () => ({ PhotoTile: () => null }))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: (props: { children: ReactNode }) => props.children,
	TooltipTrigger: (props: { render: ReactNode }) => props.render,
	TooltipContent: () => null
}))
vi.mock("@/features/photos/hooks/usePhotosDialogHost", () => ({
	usePhotosDialogHost: (params: { selectedItems: NamedItem[] }) => {
		dialogHostSelection.current = params.selectedItems

		return {
			isDialogOpen: false,
			handleItemAction: vi.fn(),
			handleBulkDialogAction: vi.fn(),
			openPreview: vi.fn(),
			renderActiveDialog: () => null
		}
	}
}))
vi.mock("@/features/photos/components/bulkActionBar", () => ({
	PhotosBulkActionBar: (props: { selectedItems: NamedItem[] }) =>
		createElement("div", { "data-testid": "bulk-bar" }, names(props.selectedItems))
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { PhotoGrid } from "@/features/photos/components/photoGrid"

const ROOT = "root-0000-0000-0000-000000000000"

function photo(label: string, name: string): PhotoItem {
	const item = narrowItem({
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: ROOT as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
	} satisfies File)

	if (item.type !== "file") {
		throw new Error("a photo narrowed to a non-file arm")
	}

	return item
}

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn()
			unobserve = vi.fn()
			disconnect = vi.fn()
		}
	)
	usePhotosStore.setState({ selectedItems: [] })
})

afterEach(cleanup)

describe("PhotoGrid — selection reconcile", () => {
	it("hands the bulk bar and the dialogs a selected photo as the grid now holds it", () => {
		const selected = [photo("p1", "old.jpg"), photo("p2", "beach.jpg")]
		const { rerender } = render(createElement(PhotoGrid, { rootUuid: ROOT, items: selected }))

		// After the grid's own reset on mount, as a click would.
		act(() => {
			usePhotosStore.setState({ selectedItems: selected })
		})
		rerender(createElement(PhotoGrid, { rootUuid: ROOT, items: [photo("p1", "new.jpg"), photo("p2", "beach.jpg")] }))

		expect(screen.getByTestId("bulk-bar").textContent).toBe("new.jpg|beach.jpg")
		expect(names(dialogHostSelection.current)).toBe("new.jpg|beach.jpg")
	})
})
