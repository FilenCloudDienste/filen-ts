// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"

// An archive opens into the archive browser in the overlay's body. What the overlay's listing cache
// keeps, and drops on close, is archiveListingScope.test.tsx's, against the real browser.

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/archive/components/archiveBrowser", () => ({
	ArchiveBrowser: ({ item, variant }: { item: DriveItem; variant: DriveVariant }) =>
		createElement("div", { "data-testid": "archive", "data-uuid": item.data.uuid, "data-variant": variant })
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

function named(name: string, size = 1n) {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000",
		stableUUID: "lineage" as File["stableUUID"],
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size, key: "k", version: 2 } }
	})
}

function overlay(item: DriveItem, variant: DriveVariant = "drive") {
	return createElement(PreviewOverlay, {
		variant,
		items: [item],
		index: 0,
		onStep: vi.fn(),
		onClose: vi.fn(),
		onItemRemoved: vi.fn()
	})
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — archive", () => {
	it("renders the archive browser for the item and the overlay's variant, whatever the archive's size", async () => {
		render(overlay(named("photos.zip", 50n * 1024n ** 3n), "sharedIn"))

		const browser = await screen.findByTestId("archive")

		expect(browser.dataset["uuid"]).toBe("file-0000-0000-0000-000000000000")
		expect(browser.dataset["variant"]).toBe("sharedIn")
	})

	it("offers no save, however the guard is set", async () => {
		render(overlay(named("photos.zip")))
		await screen.findByTestId("archive")

		usePreviewUnsavedGuardStore.setState({ dirty: true })

		expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
	})

	it("keeps the browser through a rename to another type", async () => {
		const { rerender } = render(overlay(named("photos.zip")))
		const browser = await screen.findByTestId("archive")

		rerender(overlay(named("photos.txt")))

		expect(screen.getByTestId("archive")).toBe(browser)
	})
})
