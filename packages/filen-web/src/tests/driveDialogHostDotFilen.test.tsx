// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"

// The drive dialog host's typed confirms for the root `.filen`, in the trash where its parent reads "trash".

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/drive/trash" }))
vi.mock("@/lib/dotFilen", () => ({ knownDotFilenUuid: () => null }))
vi.mock("@/features/preview/components/previewOverlay", () => ({ PreviewOverlay: () => null }))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"

function trashed(label: string, name: string) {
	return narrowItem({
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		parent: "trash",
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

afterEach(() => {
	cleanup()
	queryClient.clear()
})

describe("useDriveDialogHost — the root .filen in the trash", () => {
	it("asks for its name before deleting it permanently", () => {
		const { result } = renderHook(() => useDriveDialogHost({ variant: "trash", selectedItems: [], hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleItemAction("delete", trashed("dotfilen", ".filen"))
		})

		render(<>{result.current.renderActiveDialog()}</>)

		expect(screen.getByText("Delete the .filen directory permanently?")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Delete anyway" })).toBeTruthy()
	})

	it("says so in the empty-trash confirm, and only then", () => {
		const { result } = renderHook(() => useDriveDialogHost({ variant: "trash", selectedItems: [], hiddenNoticeApplies: false }))

		queryClient.setQueryData(driveListingQueryKey({ variant: "trash", uuid: null }), [trashed("docs", "Docs")])

		act(() => {
			result.current.handleEmptyTrash()
		})

		const { unmount } = render(<>{result.current.renderActiveDialog()}</>)

		expect(screen.queryByText(/emptying it deletes your synced settings/)).toBeNull()
		unmount()

		queryClient.setQueryData(driveListingQueryKey({ variant: "trash", uuid: null }), [trashed("dotfilen", ".filen")])
		render(<>{result.current.renderActiveDialog()}</>)

		expect(screen.getByText(/\.filen is in the trash; emptying it deletes your synced settings\./)).toBeTruthy()
	})
})
