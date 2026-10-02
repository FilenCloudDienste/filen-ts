// @vitest-environment jsdom

// The move picker hands off like a bulk confirm: several items close it at once and run as an activity
// toast; one item keeps its spinner and toasts only the result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { moveItems, toast } = vi.hoisted(() => ({
	moveItems: vi.fn(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() })
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	moveItems
}))
// The picker sits in a directory "docs" whose listing is empty.
vi.mock("@/features/drive/hooks/useDirectoryPicker", () => ({
	useDirectoryPicker: () => ({
		pathStack: [DOCS],
		targetUuid: DOCS,
		listingQuery: { status: "success", data: [] },
		items: [],
		namesQuery: { data: { [DOCS]: "Docs" } },
		descend: vi.fn(),
		goRoot: vi.fn(),
		goTo: vi.fn()
	}),
	useDirectoryPickerFilter: () => ["", vi.fn()]
}))
vi.mock("@/features/drive/components/newDirectory", () => ({ NewDirectoryDialog: () => null }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"

const DOCS = "docs-0000-0000-0000-000000000000"

function file(name: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "home-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

describe("MoveTargetDialog moving", () => {
	it("closes at once for several items and runs the move as an activity", () => {
		const items = [file("a.txt"), file("b.txt")]
		moveItems.mockReturnValue(new Promise(() => undefined))
		const onClose = vi.fn()
		render(createElement(MoveTargetDialog, { items, onClose }))

		fireEvent.click(screen.getByRole("button", { name: "Move here" }))

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(moveItems).toHaveBeenCalledExactlyOnceWith(items, DOCS, expect.any(Function))
		expect(toast).toHaveBeenCalledWith("Moving 2 items to Docs", expect.anything())
	})

	it("keeps its spinner for one item, then closes and toasts only the result", async () => {
		const only = file("a.txt")
		let finish: (outcome: unknown) => void = () => undefined
		moveItems.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		const onClose = vi.fn()
		render(createElement(MoveTargetDialog, { items: [only], onClose }))

		fireEvent.click(screen.getByRole("button", { name: "Move here" }))

		expect(onClose).not.toHaveBeenCalled()
		expect(toast).not.toHaveBeenCalled()

		await act(async () => {
			finish({ succeeded: [only], failed: [] })
			await Promise.resolve()
		})

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Moved a.txt to Docs", expect.anything())
	})

	it("stays open on the chosen target when the one item fails", async () => {
		const only = file("a.txt")

		moveItems.mockResolvedValue({
			succeeded: [],
			failed: [{ item: only, error: { species: "plain", message: "Nope", label: "Nope" } }]
		})

		const onClose = vi.fn()
		render(createElement(MoveTargetDialog, { items: [only], onClose }))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Move here" }))
			await Promise.resolve()
		})

		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Couldn't move a.txt to Docs", expect.objectContaining({ description: "Nope" }))
		})
		expect(onClose).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "Move here" })).not.toHaveProperty("disabled", true)
	})
})
