// @vitest-environment jsdom

// A tree menu level's More… opens the destination picker at that level: the host hands the level's path on to it.
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import "@/lib/i18n"

const { moveDialog, itemDialog } = vi.hoisted(() => ({ moveDialog: vi.fn(), itemDialog: vi.fn() }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/drive" }))
vi.mock("@/features/preview/components/previewOverlay", () => ({ PreviewOverlay: () => null }))

vi.mock("@/features/drive/components/moveTargetDialog", () => ({
	MoveTargetDialog: (props: unknown) => {
		moveDialog(props)

		return null
	}
}))
vi.mock("@/features/drive/components/itemDialogs", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/components/itemDialogs")>()),
	ItemDialog: (props: unknown) => {
		itemDialog(props)

		return null
	}
}))

import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { mockDirItem } from "@/tests/fixtures/sdk"

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const item = mockDirItem()
const path = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]

function host() {
	return renderHook(() => useDriveDialogHost({ variant: "drive", hiddenNoticeApplies: false }))
}

describe("the drive dialog host's start path", () => {
	it("opens a move at the level its More… was on", () => {
		const { result } = host()

		act(() => {
			result.current.handleDialogAction("move", [item], path)
		})
		render(<>{result.current.renderActiveDialog()}</>)

		expect(moveDialog).toHaveBeenLastCalledWith(expect.objectContaining({ initialPath: path }))
	})

	it("opens a bulk copy and extract at that level, and at the root otherwise", () => {
		const { result } = host()

		act(() => {
			result.current.handleDialogAction("copy", [item], path)
		})
		render(<>{result.current.renderActiveDialog()}</>)

		expect(itemDialog).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "copy", startPath: path }))

		act(() => {
			result.current.handleDialogAction("extractTo", [item])
		})
		render(<>{result.current.renderActiveDialog()}</>)

		expect(itemDialog).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "extractTo", startPath: undefined }))
	})
})
